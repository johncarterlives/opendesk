// Mock AI for the ticket view (contracts/ai.md): draft, summary, ask, triage,
// rewrite and translate. Outputs are deterministic and grounded in the
// ticket's own thread, streamed like the real API when asked for SSE.

import type { AIAnswer, AIDraft, AISummary, Contact, KBSource, Message, Priority, RewriteMode, Sentiment, Ticket, Triage } from "@/lib/api/types";
import { contactRef, db, me, userRef, type WsData } from "../db";
import { publish } from "../gateway";
import { reserve, spend } from "../aiBalance";
import { chunk, HttpError, invalid, notFound, post, sse, type Ctx } from "../router";
import { addMessage, applyPatch, computeSla, ensureTags, findTicket, newTicket, publishTicketUpdated } from "../tickets";
import { ago, escapeHtml, isRecord, MIN, nowIso, uuid } from "../util";
import { applyDecisions, severityFor } from "../decisions";
import { decisionEngine } from "./ai";
import { botForTicket } from "../bots";
import { articleUrl } from "../teams";

// ─── Text helpers ───────────────────────────────────────────────────────────

const decode = (s: string) =>
  s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&quot;/g, '"');

/** HTML to paragraphs of text: </p> splits paragraphs, <br> and list items become lines. */
export function htmlToText(html: string): string {
  return decode(
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<li[^>]*>/gi, "- ")
      .replace(/<\/li>/gi, "\n")
      .replace(/<\/(p|h\d|div|blockquote|ul|ol)>/gi, "\n\n")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function textToParagraphs(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function sentences(text: string): string[] {
  return text
    .replace(/\n+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

const GREETING = /^(hi|hello|hey|dear|hola|hallo|bonjour|ciao|olá|good (morning|afternoon))\b/i;
const SIGNOFF = /^(best|thanks|thank you|cheers|regards|kind regards|warmly|warm wishes|un saludo|gracias|viele grüße|mit freundlichen|cordialement|saludos)\b/i;
const isGreeting = (p: string) => GREETING.test(p) && p.length < 60;
const isSignoff = (p: string) => SIGNOFF.test(p) && p.length < 80;

function informative(text: string): string[] {
  return sentences(text).filter((x) => !GREETING.test(x) && !SIGNOFF.test(x) && x.length > 18 && !/^[-–]/.test(x));
}

function clip(s: string, n = 140) {
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
}

// ─── Seeded translations ────────────────────────────────────────────────────

type Translation = { lang: string; source: string; english: string };
const TRANSLATIONS: Translation[] = [];

function englishFor(html: string): string | null {
  const text = htmlToText(html);
  return TRANSLATIONS.find((x) => htmlToText(x.source) === text)?.english ?? null;
}

function detectLanguage(text: string): string {
  const t = ` ${text.toLowerCase()} `;
  const score = (re: RegExp) => (t.match(re) ?? []).length;
  const scores: [string, number][] = [
    ["es", score(/\b(el|la|que|por|para|gracias|hola|puedo|cuaderno|desde|pero|una|muy)\b/g)],
    ["de", score(/\b(und|nicht|ich|danke|hallo|bitte|seit|meine|werden|sie|grüße)\b/g)],
    ["fr", score(/\b(bonjour|merci|je|ne|pas|les|une|pour|avec|vous)\b/g)],
    ["pt", score(/\b(olá|obrigad[oa]|não|você|para|uma|com)\b/g)],
    ["it", score(/\b(ciao|grazie|non|sono|della|per|una)\b/g)],
  ];
  const best = scores.sort((a, b) => b[1] - a[1])[0];
  return best[1] >= 3 ? best[0] : "en";
}

// ─── Ticket context ─────────────────────────────────────────────────────────

function guard(ctx: Ctx) {
  if (!ctx.ws.ai.enabled) throw new HttpError(403, "ai_off", "AI is turned off for this workspace.");
}

function ticketOf(ctx: Ctx): Ticket {
  const t = findTicket(ctx.ws, ctx.params.id);
  if (!t) throw notFound("Ticket");
  return t;
}

function threadOf(ws: WsData, t: Ticket): Message[] {
  return ws.messages.filter((m) => m.ticket_id === t.id && !m.id.startsWith("tmp-")).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
}

/** A message's text in English (seeded translations stand in for the model). */
function englishText(m: Message): string {
  return htmlToText(englishFor(m.body_html) ?? m.body_html);
}

function customerText(ws: WsData, t: Ticket): string {
  return threadOf(ws, t)
    .filter((m) => m.direction === "inbound" && m.kind === "reply")
    .map(englishText)
    .join("\n\n");
}

const firstName = (t: Ticket) => (t.contact?.name ?? "there").split(" ")[0];

type Theme = { key: string; re: RegExp; tags: string[]; category: string; priority: Priority };
const THEMES: Theme[] = [
  { key: "sso", re: /\b(sso|saml|okta|single sign-on|identity provider|certificate)\b/i, tags: ["sso", "login"], category: "Authentication", priority: "high" },
  { key: "refund", re: /\b(refund|charged|duplicate charge|charge|invoice|reembolso)\b/i, tags: ["billing", "refund"], category: "Billing", priority: "normal" },
  { key: "export", re: /\b(export|pdf|exportar)\b/i, tags: ["export", "bug"], category: "Export", priority: "normal" },
  { key: "sync", re: /\b(sync|syncing|synchroni[sz]\w*|synchronisierung)\b/i, tags: ["sync", "bug"], category: "Sync", priority: "normal" },
  { key: "search", re: /\b(search|find text|ocr)\b/i, tags: ["search", "feature-request"], category: "Search", priority: "low" },
  { key: "import", re: /\b(import|evernote|notion|formatting)\b/i, tags: ["import", "bug"], category: "Import", priority: "normal" },
  { key: "account", re: /\b(password|locked|reset|sign in|log in|login)\b/i, tags: ["account", "login"], category: "Account access", priority: "high" },
  { key: "pricing", re: /\b(pricing|seats|quote|volume|enterprise)\b/i, tags: ["sales", "pricing"], category: "Sales", priority: "normal" },
  { key: "downgrade", re: /\b(downgrade|free plan|cancel)\b/i, tags: ["billing", "plan-change"], category: "Billing", priority: "low" },
  { key: "integration", re: /\b(teams|slack|integration|calendar|zapier)\b/i, tags: ["integrations", "feature-request"], category: "Integrations", priority: "low" },
];
const GENERIC: Theme = { key: "generic", re: /./, tags: ["question"], category: "General question", priority: "normal" };

function themeOf(ws: WsData, t: Ticket): Theme {
  const text = `${t.subject}\n${customerText(ws, t)}`;
  return THEMES.find((x) => x.re.test(t.subject)) ?? THEMES.find((x) => x.re.test(text)) ?? GENERIC;
}

function sentimentOf(text: string): Sentiment {
  const t = text.toLowerCase();
  if (/(still|again|unacceptable|ridiculous|third time|nobody|blocking|!!|asap|frustrat|disappoint)/.test(t)) return "frustrated";
  if (/(can't|cannot|doesn't|didn't|broken|error|fails|not working|lost|stuck|no puedo|funktioniert nicht|nicht mehr)/.test(t)) return "negative";
  if (/(thanks|thank you|great|works now|worked|perfect|appreciate|love)/.test(t)) return "positive";
  return "neutral";
}

function sourcesFor(ws: WsData, t: Ticket, theme: Theme): KBSource[] {
  const words = new Set(
    `${t.subject} ${theme.tags.join(" ")} ${theme.category}`
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2),
  );
  const scored = ws.articles
    .filter((a) => a.status === "published")
    .map((a) => ({ a, score: a.title.toLowerCase().split(/[^a-z0-9]+/).filter((w) => words.has(w)).length + (theme.re.test(a.title) ? 2 : 0) }))
    .filter((x) => x.score > 0)
    .sort((x, y) => y.score - x.score)
    .slice(0, 2);
  return scored.map(({ a }) => ({ article_id: a.id, title: a.title, url: articleUrl(ws, a) }));
}

// ─── Draft ──────────────────────────────────────────────────────────────────

const BODIES: Record<string, string> = {
  refund:
    "Thanks for flagging this, and sorry for the duplicate charge. I've checked your billing history and can see the second payment, so I've refunded it in full. It should be back on your card within 5 to 10 business days, depending on your bank.\n\nYou'll get a confirmation email from our payment provider shortly. If it hasn't arrived by the end of next week, just reply here and I'll chase it.",
  export:
    "Sorry about the trouble with the export. Large notebooks with many images can time out when they're exported to PDF. While we work on a permanent fix, exporting one section at a time works reliably: open the notebook, choose a section, then Export, PDF. Lowering the image quality under Export options also makes the file much smaller.\n\nIf a section still fails, send me the notebook name and I'll export it for you from our side.",
  sync:
    "Sorry about the sync trouble. Most of the time this clears up after signing out and back in on the device that's behind, which starts a fresh sync. If that doesn't help, open Settings, Sync and choose Sync now, then leave the app open for a minute.\n\nIf it still shows as paused, could you tell me which devices and app versions you're using? Then I can check the sync logs for your account.",
  search:
    "Search covers the text of your notes and the names of attachments today, but not the text inside images yet. It's a popular request, and I've added your vote to it. In the meantime, a short caption under each scanned page makes it searchable right away.",
  import:
    "Formatting from Evernote usually comes across as is, but tables and nested lists can lose their layout in larger imports. Could you send me one of the affected notes as an .enex file? I'll run it through our importer and see exactly where it breaks.",
  account:
    "I've unlocked your account, so you can sign in again now. If you don't remember your password, use Forgot password on the sign-in page and a reset link will arrive within a minute.",
  pricing:
    "Happy to help with this. At that size you'd be on our Business plan with volume pricing. I've asked our sales team to put together a quote, and they'll be in touch within one business day. Would you prefer monthly or annual billing?",
  downgrade:
    "You can switch to the free plan whenever you like under Settings, Billing, Change plan. The change applies at the end of your current billing period, and all of your notes stay exactly where they are.",
  integration:
    "Thanks for the suggestion. We don't have that integration yet, but I've logged your request with our product team. You can follow progress on our public roadmap, and I'll let you know here as soon as there's news.",
  generic:
    "Thanks for reaching out about this. I've looked into your account and I'm on it. Could you tell me a little more about when this started and what you see on screen? A screenshot would help a lot.\n\nI'll keep this ticket open and get back to you as soon as I know more.",
};

const SSO_1072 =
  "Thanks for confirming, and for sending the fingerprint so quickly. I've added the new signing certificate (4F:1A:9C:22:E0:7B:51:D3) to Oakridge's SAML configuration and kept the old one active alongside it, so sign-in works with either until the old certificate expires next week.\n\nCould you ask one of your users to try the Okta tile again? If anyone still lands back on the sign-in page, a hard refresh clears the cached redirect.\n\nNext time your identity team plans a rotation, you can upload the new certificate yourself under Settings, Security, Single sign-on before switching over, which avoids any downtime.";

const LOCAL_DRAFTS: Record<string, Record<string, (first: string, agent: string) => string>> = {
  es: {
    export: (first, agent) =>
      `Hola ${first}:\n\nGracias por escribirnos y perdona las molestias. Los cuadernos grandes con muchas imágenes a veces superan el tiempo límite al exportarse a PDF. Mientras preparamos una solución definitiva, exportar una sección cada vez funciona sin problemas: abre el cuaderno, elige una sección y después Exportar, PDF.\n\nSi aun así falla, envíame el nombre del cuaderno y lo exportaré yo misma desde nuestro lado para que lo tengas antes del viernes.\n\nUn saludo,\n${agent}`,
  },
  de: {
    sync: (first, agent) =>
      `Hallo ${first},\n\ndanke für Ihre Nachricht und entschuldigen Sie die Unannehmlichkeiten. Meistens hilft es, sich auf dem Gerät, das nicht aktuell ist, ab- und wieder anzumelden. Dadurch startet eine neue Synchronisierung. Falls das nicht reicht, öffnen Sie Einstellungen, Synchronisierung und wählen Sie Jetzt synchronisieren.\n\nWenn es danach immer noch hängt, schreiben Sie mir bitte, welche Geräte und App-Versionen Sie verwenden. Dann prüfe ich die Sync-Protokolle Ihres Kontos.\n\nViele Grüße\n${agent}`,
  },
};

function draftText(ctx: Ctx, t: Ticket, instructions: string): string {
  const ws = ctx.ws;
  const theme = themeOf(ws, t);
  const agent = me().name.split(" ")[0];
  const first = firstName(t);
  const lang = typeof t.custom.language === "string" ? t.custom.language : "en";
  const local = ws.ai.reply_language === "customer" ? LOCAL_DRAFTS[lang]?.[theme.key] : undefined;
  let text = local
    ? local(first, agent)
    : `Hi ${first},\n\n${t.number === 1072 ? SSO_1072 : BODIES[theme.key]}\n\nBest,\n${agent}`;
  const tone = `${ws.ai.tone} ${instructions}`.toLowerCase();
  if (/(brief|short|concise)/.test(tone)) text = rewriteText(text, "shorter");
  if (/(professional|formal)/.test(tone)) text = rewriteText(text, "more_formal");
  if (/refund/.test(instructions.toLowerCase()) && !/refund/i.test(text)) {
    text = text.replace(/\n\n([^\n]+)\n([^\n]+)$/, `\n\nI've also refunded this month's charge as a thank you for your patience.\n\n$1\n$2`);
  }
  return text;
}

// ─── Rewrite ────────────────────────────────────────────────────────────────

const CONTRACTIONS: [RegExp, string][] = [
  [/\bcan't\b/gi, "cannot"],
  [/\bwon't\b/gi, "will not"],
  [/\bdon't\b/gi, "do not"],
  [/\bdoesn't\b/gi, "does not"],
  [/\bdidn't\b/gi, "did not"],
  [/\bisn't\b/gi, "is not"],
  [/\bI'm\b/g, "I am"],
  [/\bI've\b/g, "I have"],
  [/\bI'll\b/g, "I will"],
  [/\bI'd\b/g, "I would"],
  [/\bwe're\b/gi, "we are"],
  [/\bwe've\b/gi, "we have"],
  [/\bwe'll\b/gi, "we will"],
  [/\byou're\b/gi, "you are"],
  [/\byou'll\b/gi, "you will"],
  [/\byou'd\b/gi, "you would"],
  [/\bit's\b/gi, "it is"],
  [/\bthat's\b/gi, "that is"],
  [/\bthere's\b/gi, "there is"],
  [/\bhasn't\b/gi, "has not"],
  [/\bhaven't\b/gi, "have not"],
];

const TYPOS: [RegExp, string][] = [
  [/\bteh\b/g, "the"],
  [/\brecieve(d?)\b/g, "receive$1"],
  [/\bseperate\b/g, "separate"],
  [/\bdefinately\b/g, "definitely"],
  [/\balot\b/g, "a lot"],
  [/\boccured\b/g, "occurred"],
  [/\buntill\b/g, "until"],
  [/\bwich\b/g, "which"],
  [/\bthier\b/g, "their"],
  [/\bdont\b/g, "don't"],
  [/\bcant\b/g, "can't"],
  [/\bwont\b/g, "won't"],
  [/\bim\b/g, "I'm"],
  [/\bi\b/g, "I"],
  [/\bacount\b/g, "account"],
  [/\bplease find\b/gi, "here is"],
  [/ {2,}/g, " "],
  [/ +([,.!?])/g, "$1"],
  [/([,.!?])(?=[A-Za-z])/g, "$1 "],
];

const SIMPLER: [RegExp, string][] = [
  [/\butili[sz]e\b/gi, "use"],
  [/\bapproximately\b/gi, "about"],
  [/\bhowever,\s*/gi, "but "],
  [/\badditionally,\s*/gi, "also, "],
  [/\bin order to\b/gi, "to"],
  [/\bsubsequently\b/gi, "then"],
  [/\bassistance\b/gi, "help"],
  [/\bregarding\b/gi, "about"],
  [/\bcommence\b/gi, "start"],
  [/\bsufficient\b/gi, "enough"],
  [/\bprior to\b/gi, "before"],
  [/\bat this point in time\b/gi, "now"],
  [/\bdepending on\b/gi, "based on"],
  [/\breliably\b/gi, "well"],
  [/\s*\([^)]*\)/g, ""],
];

const FILLER = /\b(just|really|actually|basically|simply)\s+/gi;

function mapBody(text: string, fn: (p: string, i: number) => string | null): string {
  const paras = text.split(/\n{2,}/);
  return paras
    .map((p, i) => (isGreeting(p) || isSignoff(p) ? p : fn(p, i)))
    .filter((p): p is string => p !== null && p.trim() !== "")
    .join("\n\n");
}

function capitalizeSentences(p: string) {
  return p.replace(/(^|[.!?]\s+)([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase());
}

export function rewriteText(text: string, mode: RewriteMode): string {
  switch (mode) {
    case "shorter": {
      let body = 0;
      const out = mapBody(text, (p) => {
        body++;
        if (body > 2) return null;
        const all = sentences(p.replace(FILLER, ""));
        // Pleasantries go first; the substance stays.
        const s = all.length > 1 ? all.filter((x) => !/^(thanks|thank you|sorry|happy to help)\b/i.test(x)) : all;
        const keep = s.length ? s : all;
        return keep.slice(0, Math.max(1, Math.ceil(keep.length / 2))).join(" ");
      });
      return out === text ? sentences(text).slice(0, -1).join(" ") || text : out;
    }
    case "longer": {
      const paras = text.split(/\n{2,}/);
      const sign = paras.findIndex((p, i) => i > 0 && isSignoff(p));
      const extra = "If anything else comes up while you try this, reply here and I'll pick it up right away. I'll keep this ticket open until you confirm everything works as expected.";
      if (sign > 0) paras.splice(sign, 0, extra);
      else paras.push(extra);
      return paras.join("\n\n");
    }
    case "friendlier": {
      const paras = text.split(/\n{2,}/);
      const warm = "Thanks so much for getting in touch, and for your patience while we looked into this.";
      const hasThanks = /thank/i.test(paras.slice(0, 2).join(" "));
      const out = paras.map((p) =>
        isSignoff(p)
          ? p.replace(/^(best|regards|kind regards|cheers),?/i, "Warm wishes,")
          : p.replace(/\bUnfortunately,\s*/g, "I'm sorry, but ").replace(/\bPlease\b/g, "Could you please").replace(/\bCould you please (\w+)([^.?]*)\./g, "Could you please $1$2?"),
      );
      if (!hasThanks) out.splice(isGreeting(out[0]) ? 1 : 0, 0, warm);
      else out.splice(out.length - (out.length > 1 && isSignoff(out[out.length - 1]) ? 1 : 0), 0, "I really appreciate you bearing with us.");
      return out.join("\n\n");
    }
    case "more_formal": {
      let out = text;
      for (const [re, to] of CONTRACTIONS) out = out.replace(re, (m) => (m[0] === m[0].toUpperCase() ? to[0].toUpperCase() + to.slice(1) : to));
      return out
        .replace(/^(Hi|Hey) ([^,\n]+),/m, "Dear $2,")
        .replace(/\bThanks\b/g, "Thank you")
        .replace(/\bthanks\b/g, "thank you")
        .replace(/^(Best|Cheers|Warm wishes),?$/m, "Kind regards,")
        .replace(/\bHappy to help\b/g, "I would be glad to help")
        .replace(/\bjust\s+/g, "");
    }
    case "fix_grammar": {
      let out = text;
      for (const [re, to] of TYPOS) out = out.replace(re, to);
      return out
        .split(/\n{2,}/)
        .map((p) => {
          const c = capitalizeSentences(p.trim());
          return isGreeting(c) || isSignoff(c) || /[.!?:,]$/.test(c) ? c : `${c}.`;
        })
        .join("\n\n");
    }
    case "simplify": {
      let out = text;
      for (const [re, to] of SIMPLER) out = out.replace(re, to);
      out = out.replace(/, which /g, ". This ").replace(/; /g, ". ");
      return mapBody(out, (p) => capitalizeSentences(p));
    }
  }
}

// ─── Translate ──────────────────────────────────────────────────────────────

const PHRASES: Record<string, [RegExp, string][]> = {
  es: [
    [/^Hi ([^,\n]+),/m, "Hola $1:"],
    [/^Dear ([^,\n]+),/m, "Estimado/a $1:"],
    [/^(Best|Kind regards|Warm wishes|Cheers),?$/m, "Un saludo,"],
    [/Thanks for reaching out about this\./g, "Gracias por escribirnos."],
    [/I've looked into your account and I'm on it\./g, "He revisado tu cuenta y ya me estoy ocupando."],
    [/Could you tell me a little more about when this started and what you see on screen\?/g, "¿Podrías contarme un poco más sobre cuándo empezó y qué ves en pantalla?"],
    [/A screenshot would help a lot\./g, "Una captura de pantalla ayudaría mucho."],
    [/I'll keep this ticket open and get back to you as soon as I know more\./g, "Mantendré este ticket abierto y te responderé en cuanto sepa más."],
    [/Sorry about the trouble with the export\./g, "Perdona las molestias con la exportación."],
    [/Thanks so much for getting in touch, and for your patience while we looked into this\./g, "Muchas gracias por escribirnos y por tu paciencia mientras lo revisábamos."],
  ],
  de: [
    [/^Hi ([^,\n]+),/m, "Hallo $1,"],
    [/^Dear ([^,\n]+),/m, "Sehr geehrte/r $1,"],
    [/^(Best|Kind regards|Warm wishes|Cheers),?$/m, "Viele Grüße"],
    [/Thanks for reaching out about this\./g, "Danke für Ihre Nachricht."],
    [/I've looked into your account and I'm on it\./g, "Ich habe mir Ihr Konto angesehen und kümmere mich darum."],
    [/Could you tell me a little more about when this started and what you see on screen\?/g, "Können Sie mir etwas genauer sagen, wann das angefangen hat und was Sie auf dem Bildschirm sehen?"],
    [/A screenshot would help a lot\./g, "Ein Screenshot würde sehr helfen."],
    [/I'll keep this ticket open and get back to you as soon as I know more\./g, "Ich lasse dieses Ticket offen und melde mich, sobald ich mehr weiß."],
    [/Sorry about the sync trouble\./g, "Entschuldigen Sie die Probleme mit der Synchronisierung."],
    [/Thanks so much for getting in touch, and for your patience while we looked into this\./g, "Vielen Dank für Ihre Nachricht und Ihre Geduld, während wir uns das angesehen haben."],
  ],
  fr: [
    [/^Hi ([^,\n]+),/m, "Bonjour $1,"],
    [/^(Best|Kind regards|Warm wishes|Cheers),?$/m, "Bien cordialement,"],
    [/Thanks for reaching out about this\./g, "Merci de nous avoir contactés."],
  ],
  pt: [
    [/^Hi ([^,\n]+),/m, "Olá $1,"],
    [/^(Best|Kind regards|Warm wishes|Cheers),?$/m, "Um abraço,"],
    [/Thanks for reaching out about this\./g, "Obrigado por entrar em contato."],
  ],
};

function translateToTarget(text: string, target: string): { text: string; complete: boolean } {
  const base = target.toLowerCase().split("-")[0];
  const table = PHRASES[base];
  if (!table) return { text, complete: false };
  let out = text;
  for (const [re, to] of table) out = out.replace(re, to);
  const leftover = informative(out).filter((s) => /\b(the|and|you|your|this|that|with|I'll|I've)\b/.test(s));
  return { text: out, complete: leftover.length === 0 };
}

// ─── Handlers ───────────────────────────────────────────────────────────────

function summarize(ws: WsData, t: Ticket): AISummary {
  const thread = threadOf(ws, t);
  const customer = customerText(ws, t);
  const lastCustomer = [...thread].reverse().find((m) => m.direction === "inbound" && m.kind === "reply");
  const lastOurs = [...thread].reverse().find((m) => m.direction === "outbound" || m.kind === "note");
  const waiting = thread.length && thread[thread.length - 1].direction === "inbound" ? "It's waiting on a reply from the team." : "The team has replied and is waiting on the customer.";
  const company = ws.contacts.find((c) => c.id === t.contact?.id)?.company?.name;
  const who = `${t.contact?.name ?? "The customer"}${company ? ` (${company})` : ""}`;
  const subj = t.subject.charAt(0).toLowerCase() + t.subject.slice(1);
  const points = [
    ...informative(customer).slice(0, 2),
    ...(lastOurs ? informative(englishText(lastOurs)).slice(0, 1) : []),
    ...(lastCustomer && lastCustomer !== thread.find((m) => m.direction === "inbound") ? informative(englishText(lastCustomer)).slice(0, 1) : []),
  ];
  return {
    summary: `${who} reports that ${subj.replace(/[.?!]$/, "")}. ${waiting}`,
    key_points: [...new Set(points)].slice(0, 4).map((p) => clip(p, 130)),
    sentiment: sentimentOf(lastCustomer ? englishText(lastCustomer) : customer),
    updated_at: nowIso(),
  };
}

function triage(ws: WsData, t: Ticket): Triage {
  const theme = themeOf(ws, t);
  const text = customerText(ws, t);
  const lastCustomer = [...threadOf(ws, t)].reverse().find((m) => m.direction === "inbound" && m.kind === "reply");
  const sentiment = sentimentOf(lastCustomer ? englishText(lastCustomer) : text);
  let priority = theme.priority;
  if (/(blocking|all \d+ users|nobody|outage|down for everyone|urgent)/i.test(text)) priority = "urgent";
  else if (sentiment === "frustrated" && priority !== "urgent") priority = "high";
  const lang = typeof t.custom.language === "string" ? t.custom.language : detectLanguage(threadOf(ws, t).map((m) => htmlToText(m.body_html)).join(" "));
  return {
    tags: theme.tags,
    suggested_tags: [],
    priority,
    severity: severityFor(priority, text),
    team_id: null,
    sentiment,
    language: lang,
    category: theme.category,
    summary: decisionEngine().provider === "typesafe" ? "" : clip(informative(text)[0] ?? t.subject, 140),
    applied: false,
  };
}

function answer(ws: WsData, t: Ticket, question: string): { text: string; html: string; sources: KBSource[] } {
  const q = question.toLowerCase();
  const thread = threadOf(ws, t);
  const first = firstName(t);
  const customer = customerText(ws, t);
  const sents = informative(customer);
  const lines = customer
    .split("\n")
    .map((x) => x.replace(/^- /, "").trim())
    .flatMap(sentences)
    .filter((x) => x.length > 8 && !GREETING.test(x) && !SIGNOFF.test(x));
  const theme = themeOf(ws, t);
  const sources = sourcesFor(ws, t, theme);
  let intro: string;
  let bullets: string[] = [];

  if (/(tried|already|steps|attempt|done so far)/.test(q)) {
    bullets = [...new Set(lines.filter((s) => /(tried|clear|restart|reboot|sign(ed|ing)? out|reinstall|doesn't help|didn't help|still|checked|works|probado|neu gestartet)/i.test(s)))].slice(0, 4);
    intro = bullets.length ? `From the thread, ${first} has already:` : `The thread doesn't mention any troubleshooting ${first} has tried yet. It may be worth asking what they've already checked.`;
  } else if (/(when|start|since|how long|timeline)/.test(q)) {
    const firstIn = thread.find((m) => m.direction === "inbound");
    bullets = [...new Set(sents.filter((s) => /(since|started|morning|yesterday|last night|ago|\d{1,2}:\d{2}|update)/i.test(s)))].slice(0, 3);
    intro = `${first} first wrote in ${firstIn ? relative(firstIn.created_at) : "recently"}.${bullets.length ? " The thread mentions:" : ""}`;
  } else if (/(who|customer|contact|company|account)/.test(q)) {
    const c = ws.contacts.find((x) => x.id === t.contact?.id);
    intro = `${t.contact?.name ?? "The customer"}${c?.company ? ` works at ${c.company.name}` : ""}${c?.email ? ` and writes from ${c.email}` : ""}. They have ${c?.ticket_count ?? 1} ${c?.ticket_count === 1 ? "ticket" : "tickets"} with you.`;
    if (c?.notes) bullets = [c.notes];
  } else if (/(next|should|suggest|recommend|reply|what do i)/.test(q)) {
    const last = thread[thread.length - 1];
    intro =
      last?.direction === "inbound"
        ? `${first}'s latest message is waiting for an answer. A good next step is to reply to it directly:`
        : `You replied last, so the ticket is waiting on ${first}. If you don't hear back, a short follow-up in a day or two keeps it moving.`;
    if (last?.direction === "inbound") bullets = informative(englishText(last)).slice(0, 2);
    if (sources.length) bullets.push(`The article "${sources[0].title}" covers this and is worth linking.`);
  } else {
    intro = `${first} wrote in about "${t.subject}".`;
    bullets = sents.slice(0, 3);
  }
  const text = [intro, ...bullets.map((b) => `- ${clip(b, 160)}`)].join("\n");
  const html = `<p>${escapeHtml(intro)}</p>${bullets.length ? `<ul>${bullets.map((b) => `<li>${escapeHtml(clip(b, 160))}</li>`).join("")}</ul>` : ""}`;
  return { text, html, sources: /(next|should|suggest|recommend|article|docs|help)/.test(q) || sources.length ? sources : [] };
}

function relative(iso: string): string {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (m < 60) return `${m} minutes ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} ${h === 1 ? "hour" : "hours"} ago`;
  const d = Math.round(h / 24);
  return `${d} ${d === 1 ? "day" : "days"} ago`;
}

/** Stream text in small chunks; the model "thinks" briefly first. */
function stream(ctx: Ctx, text: string, final: unknown) {
  return sse(ctx, chunk(text, 2), final, 28);
}

export function registerAiTicket() {
  post("/v1/tickets/:id/ai/draft", (ctx) => {
    guard(ctx);
    const t = ticketOf(ctx);
    reserve(ctx.ws, "draft_reply");
    const instructions = typeof ctx.body.instructions === "string" ? ctx.body.instructions.slice(0, 2000) : "";
    const text = draftText(ctx, t, instructions);
    const res: AIDraft = { body_html: textToParagraphs(text), body_text: text, sources: sourcesFor(ctx.ws, t, themeOf(ctx.ws, t)) };
    spend(ctx.ws, "draft_reply");
    return stream(ctx, text, res);
  });

  post("/v1/tickets/:id/ai/summary", (ctx) => {
    guard(ctx);
    const t = ticketOf(ctx);
    reserve(ctx.ws, "summarize");
    const s = summarize(ctx.ws, t);
    t.custom = { ...t.custom, ai_summary: s, ai_sentiment: s.sentiment };
    publishTicketUpdated(ctx.ws, t, ["custom"]);
    spend(ctx.ws, "summarize");
    return s;
  });

  post("/v1/tickets/:id/ai/ask", (ctx) => {
    guard(ctx);
    const t = ticketOf(ctx);
    const question = typeof ctx.body.question === "string" ? ctx.body.question.trim() : "";
    if (!question) throw invalid("question is required");
    reserve(ctx.ws, "copilot");
    const a = answer(ctx.ws, t, question);
    const res: AIAnswer = { answer_html: a.html, sources: a.sources };
    spend(ctx.ws, "copilot");
    return stream(ctx, a.text, res);
  });

  post("/v1/tickets/:id/ai/triage", (ctx) => {
    guard(ctx);
    const t = ticketOf(ctx);
    reserve(ctx.ws, "triage");
    const r = triage(ctx.ws, t);
    if (ctx.body.apply === true && decisionEngine().provider === "typesafe") {
      const { decisions, suggestions } = applyDecisions(ctx.ws, t, { priority: r.priority, severity: r.severity!, tags: r.tags, team_id: r.team_id, sentiment: r.sentiment, category: r.category, language: r.language }, { via: "ai_triage", force: true, publish: true });
      r.decisions = decisions;
      r.suggestions = suggestions;
      r.applied = true;
    } else if (ctx.body.apply === true) {
      const before = ctx.ws.activities.length;
      const { changes } = applyPatch(ctx.ws, t, { priority: r.priority, add_tags: r.tags }, null, false, { lenient: true, createLabels: ctx.ws.workspace.settings.label_creation !== "admins" });
      for (const a of ctx.ws.activities.slice(before)) {
        a.actor = { type: "ai", user: null };
        a.data = { ...a.data, automation_name: "AI triage" };
        publish(ctx.ws, "activity.created", { ticket_id: t.id, activity: a });
      }
      t.custom = { ...t.custom, ai_sentiment: r.sentiment, language: r.language, ai_category: r.category };
      publishTicketUpdated(ctx.ws, t, [...changes, "custom"]);
      r.applied = true;
    }
    spend(ctx.ws, "triage");
    return r;
  });

  post("/v1/ai/rewrite", (ctx) => {
    guard(ctx);
    const html = typeof ctx.body.html === "string" ? ctx.body.html : "";
    const mode = ctx.body.mode as RewriteMode;
    if (!html.trim()) throw invalid("html is required");
    if (!["friendlier", "more_formal", "shorter", "longer", "fix_grammar", "simplify"].includes(mode)) throw invalid("Unknown rewrite mode");
    reserve(ctx.ws, "rewrite");
    const text = rewriteText(htmlToText(html), mode);
    spend(ctx.ws, "rewrite");
    return stream(ctx, text, { html: textToParagraphs(text) });
  });

  post("/v1/ai/translate", (ctx) => {
    guard(ctx);
    const target = typeof ctx.body.target === "string" ? ctx.body.target : "";
    const html = typeof ctx.body.html === "string" ? ctx.body.html : null;
    const plain = typeof ctx.body.text === "string" ? ctx.body.text : null;
    if (!target) throw invalid("target is required");
    if (!html && !plain) throw invalid("html or text is required");
    reserve(ctx.ws, "translate");
    const srcText = html ? htmlToText(html) : plain!;
    const source = detectLanguage(srcText);
    let outText: string;
    const base = target.toLowerCase().split("-")[0];
    if (base === "en") {
      const known = html ? englishFor(html) : null;
      outText = known ? htmlToText(known) : source === "en" ? srcText : `(Mock translation) ${srcText}`;
    } else {
      const r = translateToTarget(srcText, target);
      outText = r.complete ? r.text : `${r.text}\n\n(Mock translation: only common phrases are translated in demo mode.)`;
    }
    spend(ctx.ws, "translate");
    return html ? { html: textToParagraphs(outText), source_language: source } : { text: outText, source_language: source };
  });

  // A question about the app, answered from the excerpts the app's own search found.
  post("/v1/ai/app-help", (ctx) => {
    guard(ctx);
    const question = typeof ctx.body.question === "string" ? ctx.body.question.trim() : "";
    const sources = Array.isArray(ctx.body.sources) ? ctx.body.sources.filter(isRecord) : [];
    if (!question) throw invalid("question is required");
    if (!sources.length || sources.length > 8) throw invalid("sources must have 1 to 8 items");
    reserve(ctx.ws, "app_help");
    const first = String(sources[0].title ?? "").trim();
    spend(ctx.ws, "app_help");
    return { answer: `(Mock answer) Go to ${first}. The places and docs below have the details.` };
  });

  seedAiTicketData();
}

// ─── Seed: foreign-language tickets, a stored summary, a bot answer ─────────

function contact(ws: WsData, name: string, email: string, language: string, notes: string): Contact {
  const c: Contact = {
    id: uuid(),
    email,
    emails: [],
    name,
    phone: "",
    avatar_url: null,
    avatar_source: null,
    company: null,
    external_id: null,
    notes,
    tags: [],
    fields: {},
    custom: { language },
    blocked: false,
    ticket_count: 1,
    created_at: ago(90 * 24 * 60 * MIN),
    updated_at: ago(2 * 60 * MIN),
  };
  ws.contacts.push(c);
  return c;
}

function foreignTicket(ws: WsData, opts: { contact: Contact; subject: string; html: string; english: string; language: string; minutesAgo: number; mine: boolean }) {
  const t = newTicket(ws, {
    subject: opts.subject,
    contact: contactRef(opts.contact),
    channel: "email",
    priority: "normal",
    assignee: opts.mine ? userRef(db.meId) : null,
    team_id: ws.teams.find((x) => x.name === "Support")?.id ?? null,
    created_at: ago(opts.minutesAgo * MIN),
  });
  t.number = Math.max(...ws.tickets.map((x) => x.number)) + 1;
  t.custom = { ...t.custom, language: opts.language };
  const m = addMessage(ws, t, { kind: "reply", direction: "inbound", html: opts.html, at: t.created_at }, { publish: false });
  (m as Message & { custom?: Record<string, unknown> }).custom = { language: opts.language };
  TRANSLATIONS.push({ lang: opts.language, source: opts.html, english: opts.english });
  return t;
}

function seedAiTicketData() {
  const ws = db.workspaces[0];
  // Once per workspace (seeded triage also sets custom.language, so look for the seeded contact).
  if (!ws || ws.contacts.some((c) => c.email === "lucia@estudiomarbella.es")) return;

  const lucia = contact(ws, "Lucía Fernández", "lucia@estudiomarbella.es", "es", "Architect, Marbella studio. Prefers Spanish.");
  foreignTicket(ws, {
    contact: lucia,
    subject: "No puedo exportar mi cuaderno a PDF",
    language: "es",
    minutesAgo: 22,
    mine: true,
    html: "<p>Hola,</p><p>Desde ayer no puedo exportar mi cuaderno «Proyecto Marbella» a PDF. La exportación se queda en el 90 % y después aparece un error. Es un cuaderno grande, con unas 200 fotos de la obra.</p><p>Ya he probado a cerrar sesión y volver a entrar, pero no ha servido de nada. Necesito enviar el PDF a un cliente el viernes. ¿Me podéis ayudar?</p><p>Gracias,<br>Lucía</p>",
    english:
      "<p>Hi,</p><p>Since yesterday I can't export my notebook \"Proyecto Marbella\" to PDF. The export gets stuck at 90% and then an error appears. It's a large notebook, with about 200 photos from the construction site.</p><p>I've already tried signing out and back in, but it didn't help. I need to send the PDF to a client on Friday. Can you help?</p><p>Thanks,<br>Lucía</p>",
  });

  const katrin = contact(ws, "Katrin Vogel", "k.vogel@vogel-architekten.de", "de", "");
  const sync = foreignTicket(ws, {
    contact: katrin,
    subject: "Synchronisierung zwischen iPad und Mac hängt",
    language: "de",
    minutesAgo: 48,
    mine: false,
    html: "<p>Hallo Margin-Team,</p><p>seit dem letzten Update werden meine Notizen nicht mehr zwischen iPad und Mac synchronisiert. Auf dem iPad steht seit gestern „Synchronisierung angehalten“. Neue Notizen vom Mac erscheinen dort einfach nicht.</p><p>Ich habe die App bereits neu gestartet und das iPad neu gebootet. Können Sie sich das bitte ansehen?</p><p>Viele Grüße<br>Katrin Vogel</p>",
    english:
      "<p>Hello Margin team,</p><p>Since the last update, my notes no longer sync between my iPad and Mac. Since yesterday the iPad has shown \"Sync paused\". New notes from the Mac just don't appear there.</p><p>I've already restarted the app and rebooted the iPad. Could you please take a look?</p><p>Best regards<br>Katrin Vogel</p>",
  });

  // Ollie triaged it but was not sure enough to apply anything: priority, severity and
  // labels wait in the Ollie panel for an agent to accept or dismiss.
  applyDecisions(
    ws,
    sync,
    { priority: "high", severity: "sev3", tags: ["Sync", "Mobile"], team_id: null, sentiment: "negative", category: "problem", language: "de" },
    { via: "auto_triage", at: new Date(Date.parse(sync.created_at) + 40_000).toISOString(), confidence: { priority: 0.64, severity: 0.58, label: 0.62 } },
  );

  // A stored summary on the SSO story.
  const sso = ws.tickets.find((t) => t.number === 1072);
  if (sso) {
    sso.custom = {
      ...sso.custom,
      ai_sentiment: "neutral",
      ai_summary: {
        summary: "Oakridge Health can't sign in through Okta since their identity team rotated the SAML signing certificate early. Dana has sent the new fingerprint and is waiting for us to add it.",
        key_points: [
          "All 180 Okta users loop back to the sign-in page since 07:40 CET",
          "Jonas confirmed every assertion is signed with an unknown certificate",
          "New fingerprint is 4F:1A:9C:22:E0:7B:51:D3; Dana prefers not to roll back",
        ],
        sentiment: "neutral",
        updated_at: ago(40 * MIN),
      } satisfies AISummary,
    };
  }

  // A widget agent answer on a chat ticket, rated up by the visitor.
  const chat = ws.tickets.find((t) => t.channel === "chat" && !t.spam && t.status === "open");
  const bot = botName(ws, chat);
  if (chat) {
    const firstIn = ws.messages.find((m) => m.ticket_id === chat.id && m.direction === "inbound");
    const article = ws.articles.find((a) => a.status === "published");
    if (firstIn) {
      const keep = { last_message_at: chat.last_message_at, last_message_preview: chat.last_message_preview, first_responded_at: chat.first_responded_at, sla: chat.sla, status: chat.status, message_count: chat.message_count };
      addMessage(
        ws,
        chat,
        {
          kind: "reply",
          direction: "outbound",
          html: `<p>Here's what I found in the help center${article ? `: <a href="${escapeHtml(articleUrl(ws, article))}">${escapeHtml(article.title)}</a>` : ""}. If that doesn't answer it, choose Talk to a person and the team will pick this up.</p>`,
          at: new Date(Date.parse(firstIn.created_at) + 20_000).toISOString(),
          bot,
          ai_rating: "up",
        },
        { publish: false },
      );
      Object.assign(chat, keep, { message_count: keep.message_count + 1 });
    }
  }

  seedAgentChat(ws, bot);
  seedDocsBotChat(ws);
  seedWaitingChats(ws, bot);
}

/** The name the AI agent answers under on a ticket: its widget's or mailbox's bot (contracts/bots.md). */
export function botName(ws: WsData, t?: Ticket): string {
  return botForTicket(ws, t).name;
}

/**
 * A chat the widget agent handled: it cancelled an order after the visitor
 * confirmed, then handed off a delivery question (rated down).
 */
function seedAgentChat(ws: WsData, bot: string) {
  const c = ws.contacts.find((x) => x.name === "Freya Nilsen") ?? ws.contacts[0];
  if (!c) return;
  const start = 38;
  const t = newTicket(ws, {
    subject: "Cancel order #4821",
    contact: contactRef(c),
    channel: "chat",
    priority: "normal",
    team_id: ws.teams.find((x) => x.name === "Support")?.id ?? null,
    created_at: ago(start * MIN),
  });
  t.number = Math.max(...ws.tickets.map((x) => x.number)) + 1;
  const first = c.name.split(" ")[0];
  const at = (min: number) => ago(min * MIN);
  const thread: Parameters<typeof addMessage>[2][] = [
    { kind: "reply", direction: "inbound", html: "<p>Hi, I ordered the paper notebook bundle twice by mistake. Can you cancel order #4821?</p>", at: at(start) },
    {
      kind: "reply",
      direction: "outbound",
      html: `<p>Hi ${escapeHtml(first)}, I found order #4821: the paper notebook bundle for $48.00, not shipped yet. I can cancel it and refund the card ending 4242. Please confirm below.</p>`,
      at: at(start - 0.4),
      bot,
      ai_action: { id: uuid(), title: "Cancel order", summary: "Cancel order #4821 and refund $48.00 to the card ending 4242", status: "confirmed", tool: "Shop" },
    },
    {
      kind: "reply",
      direction: "outbound",
      html: "<p>Done. Order #4821 is cancelled and $48.00 is on its way back to the card ending 4242. Refunds usually show within 5 to 10 business days.</p>",
      at: at(start - 1.5),
      bot,
    },
    { kind: "reply", direction: "inbound", html: "<p>Thanks! And will my other order arrive before Friday? I need it for a workshop.</p>", at: at(start - 3) },
    {
      kind: "reply",
      direction: "outbound",
      html: "<p>Orders usually ship within 2 business days, but I can't promise a delivery date. I've asked the team to check order #4822 for you, and they'll reply here.</p>",
      at: at(start - 3.4),
      bot,
      ai_rating: "down",
    },
  ];
  for (const m of thread) addMessage(ws, t, m, { publish: false });
  // The agent's replies don't count as the team's first response.
  t.first_responded_at = null;
  t.status = "open";
  t.sla = computeSla(ws, t, false);
  const handedBy = botForTicket(ws, t);
  t.custom = { ...t.custom, ai_handoff: true, ai_handoff_at: at(start - 3.4), ai_handoff_bot: handedBy.name, language: "en" };
  ws.activities.push({ id: uuid(), ticket_id: t.id, actor: { type: "ai", user: null }, type: "ai_handoff", data: { bot: handedBy.name, bot_id: handedBy.id }, created_at: at(start - 3.4) });
  c.ticket_count++;
}

/**
 * A chat on the docs widget, answered as its own bot (Pip, contracts/bots.md): a playful
 * answer with a cited page, then its handoff line when the visitor needs a person.
 */
function seedDocsBotChat(ws: WsData) {
  const w = ws.widgets.find((x) => x.name === "Docs");
  const pip = w?.bot_id ? ws.bots?.find((b) => b.id === w.bot_id) : undefined;
  const c = ws.contacts.find((x) => x.name === "Kofi Lindqvist") ?? ws.contacts[1];
  if (!w || !pip || !c) return;
  const start = 52;
  const t = newTicket(ws, {
    subject: "SAML with Okta on the Team plan",
    contact: contactRef(c),
    channel: "chat",
    priority: "normal",
    team_id: ws.teams.find((x) => x.name === "Support")?.id ?? null,
    created_at: ago(start * MIN),
  });
  t.number = Math.max(...ws.tickets.map((x) => x.number)) + 1;
  t.widget_id = w.id;
  t.brand_id = w.brand_id;
  t.page_url = "https://docs.margin.app/guides/sso";
  const at = (min: number) => ago(min * MIN);
  const first = escapeHtml(c.name.split(" ")[0]);
  const by = { bot: pip.name, bot_id: pip.id };
  const thread: Parameters<typeof addMessage>[2][] = [
    { kind: "reply", direction: "inbound", html: "<p>How do I connect Okta for SAML sign-in?</p>", at: at(start) },
    {
      kind: "reply",
      direction: "outbound",
      html: `<p>Hey ${first}! 👋 Okta takes about five minutes: add Margin from the Okta app catalog, paste the metadata URL into <strong>Settings, Security, Single sign-on</strong>, then test with one account first ✨</p><p>The full walkthrough is in <a href="https://docs.margin.app/guides/sso">Set up SSO with Okta</a> 🙌</p>`,
      at: at(start - 0.3),
      ...by,
      ai_rating: "up",
    },
    { kind: "reply", direction: "inbound", html: "<p>The SSO page says it needs Business. We're on Team, can we get a trial of it?</p>", at: at(start - 4) },
    { kind: "reply", direction: "outbound", html: `<p>${escapeHtml(pip.personality.handoff_message)}</p>`, at: at(start - 4.3), ...by },
  ];
  for (const m of thread) addMessage(ws, t, m, { publish: false });
  t.first_responded_at = null;
  t.status = "open";
  t.sla = computeSla(ws, t, false);
  t.custom = { ...t.custom, ai_handoff: true, ai_handoff_at: at(start - 4.3), ai_handoff_bot: pip.name, language: "en" };
  ws.activities.push({ id: uuid(), ticket_id: t.id, actor: { type: "ai", user: null }, type: "ai_handoff", data: { bot: pip.name, bot_id: pip.id }, created_at: at(start - 4.3) });
  c.ticket_count++;
}

/**
 * Live chats waiting for the team right now, so the inbox shows its urgent state: two
 * visitors Ollie handed off a moment ago, and one Ollie is still answering (it turns
 * urgent after a minute without a reply).
 */
function seedWaitingChats(ws: WsData, bot: string) {
  const people = ["Hugo Moreau", "Aisha Bello", "Julia Novak"].map((n) => ws.contacts.find((c) => c.name === n));
  const pick = (i: number) => people[i] ?? ws.contacts[(i * 7 + 3) % ws.contacts.length];
  const team = ws.teams.find((x) => x.name === "Support")?.id ?? null;
  const chats: { subject: string; labels: string[]; thread: { who: "visitor" | "bot"; text: string; sec: number }[]; handoffSec?: number }[] = [
    {
      subject: "Charged twice for my upgrade",
      labels: ["Billing", "Refund"],
      thread: [
        { who: "visitor", text: "Hi, I upgraded to Business this morning and my card was charged twice.", sec: 260 },
        { who: "bot", text: "Sorry about that. Refunds need a person on the billing team, so I've asked them to look at your account. They'll reply here.", sec: 250 },
        { who: "visitor", text: "Ok, the second charge is 49 EUR on the 12th.", sec: 200 },
        { who: "visitor", text: "Is anyone there?", sec: 60 },
      ],
      handoffSec: 250,
    },
    {
      subject: "Can't get into my workspace",
      labels: ["SSO"],
      thread: [
        { who: "visitor", text: "My login link keeps expiring before I can click it", sec: 140 },
        { who: "bot", text: "Login links last 15 minutes. If they expire sooner, your email may be opening them first. Try copying the code instead of clicking the link.", sec: 130 },
        { who: "visitor", text: "Tried that. Can I talk to a real person please?", sec: 75 },
      ],
      handoffSec: 74,
    },
    {
      subject: "Do you have an education discount?",
      labels: ["Question"],
      thread: [{ who: "visitor", text: "Hello! I teach at a university. Do you have an education discount for my class?", sec: 12 }],
    },
  ];
  chats.forEach((c, i) => {
    const contact = pick(i);
    if (!contact) return;
    const startSec = c.thread[0].sec;
    const t = newTicket(ws, {
      subject: c.subject,
      contact: contactRef(contact),
      channel: "chat",
      priority: i === 0 ? "high" : "normal",
      team_id: team,
      created_at: ago(startSec * 1000),
    });
    t.number = Math.max(...ws.tickets.map((x) => x.number)) + 1;
    for (const m of c.thread) {
      addMessage(
        ws,
        t,
        { kind: "reply", direction: m.who === "visitor" ? "inbound" : "outbound", html: `<p>${escapeHtml(m.text)}</p>`, at: ago(m.sec * 1000), bot: m.who === "bot" ? bot : undefined },
        { publish: false },
      );
    }
    t.status = "open";
    t.tags = ensureTags(ws, c.labels, false);
    t.sla = computeSla(ws, t, false);
    if (c.handoffSec !== undefined) {
      const at = ago(c.handoffSec * 1000);
      const handedBy = botForTicket(ws, t);
      t.custom = { ...t.custom, ai_handoff: true, ai_handoff_at: at, ai_handoff_bot: handedBy.name, language: "en" };
      ws.activities.push({ id: uuid(), ticket_id: t.id, actor: { type: "ai", user: null }, type: "ai_handoff", data: { bot: handedBy.name, bot_id: handedBy.id }, created_at: at });
    }
    contact.ticket_count++;
  });
}
