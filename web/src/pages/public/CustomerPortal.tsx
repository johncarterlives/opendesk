import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useMatches, useParams, useRouterState } from "@tanstack/react-router";
import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Turnstile, useTurnstileSiteKey, type TurnstileHandle } from "@/components/auth/Turnstile";
import { Notice } from "@/components/auth/parts";
import { LanguageSwitcher, usePublicLocale } from "@/components/help/locale";
import { EmptyState } from "@/components/ui/empty";
import { Button } from "@/components/ui/button";
import { TextInput, Textarea } from "@/components/ui/input";
import type { CustomerMessage } from "@/lib/customerPortal/types";
import { customerPortal, refreshCustomer, customerIdentityVersion, subscribeCustomerIdentity } from "@/lib/customerPortal/client";
import { fullDate } from "@/lib/format";
import { statusTone, tone } from "@/lib/tones";
import { isApiError } from "@/lib/api/client";
import "@/components/help/help.css";

const publicTextLink = "text-fg-2 underline underline-offset-4 hover:text-fg focus-visible:rounded-sm focus-visible:shadow-[0_0_0_3px_var(--focus)]";

export default function CustomerPortal() {
  const identity = useSyncExternalStore(subscribeCustomerIdentity, customerIdentityVersion);
  const { slug = "", ticketId } = useParams({ strict: false }) as { slug?: string; ticketId?: string };
  const path = useRouterState({ select: (s) => s.location.pathname });
  const matches = useMatches();
  const resetToken = matches.map((m) => (m.context as { portalResetToken?: string }).portalResetToken).find((v) => v !== undefined) ?? "";
  const mode = path.endsWith("/forgot") ? "forgot" : path.endsWith("/reset") ? "reset" : ticketId ? "detail" : "home";
  const { data: brand, isPending, isError } = useQuery({ queryKey: ["customerPortal", "config", slug], queryFn: () => customerPortal.config(slug), retry: false });
  const { locale, loaded } = usePublicLocale(brand?.locale, !isPending, !!brand?.locale_fixed);
  const { t } = useTranslation("public");
  const [signedIn, setSignedIn] = useState(false);
  const [checking, setChecking] = useState(true);
  const [logoutError, setLogoutError] = useState(false);
  useEffect(() => { let alive = true; setSignedIn(false); setChecking(true); void refreshCustomer(slug).catch(() => false).then((ok) => { if (alive) { setSignedIn(ok); setChecking(false); } }); return () => { alive = false; }; }, [slug]);
  useEffect(() => { document.title = brand?.title ? `${t("portal.title")} · ${brand.title}` : t("portal.title"); const meta = document.createElement("meta"); meta.name = "robots"; meta.content = "noindex, nofollow"; document.head.append(meta); return () => meta.remove(); }, [brand, t]);
  const base = `/portal/${encodeURIComponent(slug)}`;
  return <div data-public-page className="ph-no-capture flex min-h-dvh flex-col bg-surface px-4">
    <header className="mx-auto flex w-full max-w-3xl items-center justify-between border-b border-line py-5">
      <a href={base} className="flex items-center gap-2 font-semibold text-fg">{brand?.logo_url && <img src={brand.logo_url} alt="" width={128} height={32} className="max-h-8 max-w-32 object-contain" />}<bdi style={{ color: /^#[0-9a-f]{6}$/i.test(brand?.color ?? "") ? brand?.color : undefined }}>{brand?.title}</bdi></a>
      {signedIn && <Button variant="ghost" onClick={() => void customerPortal.logout(slug).then(() => { setSignedIn(false); window.location.assign(base); }).catch(() => setLogoutError(true))}>{t("portal.sign_out")}</Button>}
    </header>
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col py-10">{logoutError && <Notice>{t("portal.error")}</Notice>}{!loaded || isPending ? <p>{t("portal.loading")}</p> : isError || !brand ? <Notice>{t("portal.unavailable")}</Notice> : mode === "forgot" || mode === "reset" || (!signedIn && !checking) ? <AuthForm key={mode} slug={slug} mode={mode === "detail" || mode === "home" ? "login" : mode} resetToken={resetToken} onLogin={() => { setChecking(false); setSignedIn(true); }} /> : checking ? <p>{t("portal.loading")}</p> : mode === "detail" && ticketId ? <Ticket key={`${slug}:${ticketId}:${identity}`} slug={slug} id={ticketId} /> : <TicketList key={`${slug}:${identity}`} slug={slug} helpURL={brand.help_url} />}</main>
    <footer className="mx-auto flex h-14 w-full max-w-3xl items-center justify-end text-xs text-fg-4">{!brand?.locale_fixed && <LanguageSwitcher current={locale} />}</footer>
  </div>;
}
export function AuthForm({ slug, mode, resetToken, onLogin }: { slug: string; mode: "login" | "forgot" | "reset"; resetToken: string; onLogin: () => void }) {
  const { t } = useTranslation("public");
  const base = `/portal/${encodeURIComponent(slug)}`;
  const [email, setEmail] = useState(""); const [password, setPassword] = useState(""); const [captcha, setCaptcha] = useState<string | null>(null); const [sent, setSent] = useState(false); const [weak, setWeak] = useState(false); const [error, setError] = useState(""); const [pending, setPending] = useState(false);
  const siteKey = useTurnstileSiteKey(); const turnstile = useRef<TurnstileHandle>(null);
  async function submit(e: FormEvent) { e.preventDefault(); setError(""); setPending(true); try {
    if (mode === "login") { const result = await customerPortal.login(slug, email.trim(), password, captcha ?? undefined); if (result.change_password) setWeak(true); else onLogin(); }
    else if (mode === "forgot") { await customerPortal.forgot(slug, email.trim(), captcha ?? undefined); setSent(true); }
    else { await customerPortal.reset(slug, resetToken, password, captcha ?? undefined); setSent(true); }
  } catch (err) { turnstile.current?.reset(); setError(isApiError(err, "weak_password") ? t("portal.weak_password") : isApiError(err, "invalid_token") ? t("portal.invalid_link") : t("portal.error")); } finally { setPending(false); } }
  return <div className="mx-auto w-full max-w-sm py-8"><h1 className="text-pretty text-2xl font-semibold text-fg">{t(`portal.${mode}`)}</h1>
    {mode === "reset" && !resetToken ? <Notice>{t("portal.invalid_link")} <a href={`${base}/forgot`} className={publicTextLink}>{t("portal.get_link")}</a></Notice> : weak ? <p className="mt-4 text-fg-3">{t("portal.password_change")} <a className={publicTextLink} href={`${base}/forgot`}>{t("portal.get_link")}</a></p> : sent ? <div className="mt-4"><p className="text-fg-3" role="status">{t(mode === "forgot" ? "portal.email_sent" : "portal.reset_done")}</p><a className={`mt-4 inline-block ${publicTextLink}`} href={base}>{t("portal.back_login")}</a></div> : <form className="mt-6 flex flex-col gap-4" onSubmit={(e) => void submit(e)}>
      {error && <Notice>{error}</Notice>}
      {mode !== "reset" && <label className="text-sm font-medium">{t("portal.email")}<TextInput className="mt-1.5" type="email" name="email" autoComplete="email" spellCheck={false} required value={email} onChange={(e) => setEmail(e.target.value)} /></label>}
      {mode !== "forgot" && <label className="text-sm font-medium">{t("portal.password")}<TextInput className="mt-1.5" type="password" name="password" autoComplete={mode === "reset" ? "new-password" : "current-password"} required value={password} onChange={(e) => setPassword(e.target.value)} /></label>}
      <Turnstile ref={turnstile} onToken={setCaptcha} action={mode === "login" ? "login" : "password_reset"} />
      <Button variant="primary" size="lg" type="submit" loading={pending} disabled={pending || (!!siteKey && !captcha) || (mode === "reset" && !resetToken)}>{t(`portal.${mode}_action`)}</Button>
      {mode === "login" && <a className={`text-sm ${publicTextLink}`} href={`${base}/forgot`}>{t("portal.forgot_link")}</a>}
      {mode !== "login" && <a className={`text-sm ${publicTextLink}`} href={base}>{t("portal.back_login")}</a>}
    </form>}</div>;
}
export function TicketList({ slug, helpURL }: { slug: string; helpURL: string }) {
  const { t } = useTranslation("public"); const [cursor, setCursor] = useState<string>();
  const tickets = useQuery({ queryKey: ["customerPortal", slug, "tickets", cursor], queryFn: () => customerPortal.tickets(slug, cursor), retry: false });
  return <><h1 className="text-pretty text-2xl font-semibold">{t("portal.requests")}</h1>{tickets.isPending ? <p className="mt-6">{t("portal.loading")}</p> : tickets.isError ? <Notice className="mt-6">{t("portal.error")}</Notice> : !tickets.data.data.length ? <EmptyState compact art="inbox" title={t("portal.empty")} action={<a className={publicTextLink} href={helpURL}>{t("portal.help_center")}</a>} /> : <div className="mt-6 border-y border-line">{tickets.data.data.map((ticket) => <Link key={ticket.id} to="/portal/$slug/tickets/$ticketId" params={{ slug, ticketId: ticket.id }} className="flex items-center justify-between gap-4 border-b border-line py-4 last:border-0 hover:bg-hover focus-visible:relative focus-visible:z-10 focus-visible:shadow-[0_0_0_3px_var(--focus)]"><span className="min-w-0 flex-1 break-words"><span className="mono tabular-nums text-fg-4">#{ticket.number}</span> <bdi>{ticket.subject}</bdi></span><Status status={ticket.status} /></Link>)}</div>}{tickets.data?.next_cursor && <Button className="mt-4 self-start" variant="secondary" onClick={() => setCursor(tickets.data.next_cursor ?? undefined)}>{t("portal.next")}</Button>}</>;
}
function Status({ status }: { status: string }) {
  const { t } = useTranslation("public");
  const hue = Object.hasOwn(statusTone, status) ? statusTone[status as keyof typeof statusTone] : "gray";
  return <span className={`rounded px-2 py-1 text-xs font-medium ${tone[hue].chip}`}>{t(`portal.status.${status}`, { defaultValue: status.replaceAll("_", " ") })}</span>;
}
export function Ticket({ slug, id }: { slug: string; id: string }) {
  const { t } = useTranslation("public"); const qc = useQueryClient(); const [body, setBody] = useState(""); const [cursor, setCursor] = useState<string>(); const [sentReplies, setSentReplies] = useState<CustomerMessage[]>([]);
  const ticket = useQuery({ queryKey: ["customerPortal", slug, "ticket", id], queryFn: () => customerPortal.ticket(slug, id), retry: false });
  const messages = useQuery({ queryKey: ["customerPortal", slug, "messages", id, cursor], queryFn: () => customerPortal.messages(slug, id, cursor), retry: false });
  const reply = useMutation({ mutationFn: () => customerPortal.reply(slug, id, body), onSuccess: (message) => { setBody(""); setSentReplies((current) => [...current, message]); void qc.invalidateQueries({ queryKey: ["customerPortal", slug] }); } });
  return <><Link to="/portal/$slug" params={{ slug }} className={`mb-5 inline-block text-sm ${publicTextLink}`}>{t("portal.back_requests")}</Link>{ticket.isError || messages.isError ? <Notice>{t("portal.error")}</Notice> : ticket.isPending || messages.isPending ? <p>{t("portal.loading")}</p> : <><h1 className="text-pretty break-words text-2xl font-semibold"><bdi>{ticket.data?.subject}</bdi></h1><div className="my-6 flex-1 divide-y divide-line border-y border-line">{messages.data.data.length === 0 && sentReplies.length === 0 && <p className="py-4 text-fg-3">{t("portal.no_messages")}</p>}{messages.data?.data.map((m) => <article key={m.id} className="py-4"><div className="mb-2 text-xs text-fg-3">{t(m.direction === "inbound" ? "portal.you" : "portal.team")} · {fullDate(m.created_at)}</div><p className="whitespace-pre-wrap break-words">{m.body_text}</p></article>)}{sentReplies.filter((sent) => !messages.data.data.some((message) => message.id === sent.id)).map((sent) => <article key={sent.id} className="py-4"><div className="mb-2 text-xs text-fg-3">{t("portal.you")} · {fullDate(sent.created_at)}</div><p className="whitespace-pre-wrap break-words">{sent.body_text}</p></article>)}{messages.data?.next_cursor && <Button variant="secondary" onClick={() => setCursor(messages.data.next_cursor ?? undefined)}>{t("portal.next")}</Button>}</div><form className="sticky bottom-0 flex flex-col gap-2 border-t border-line bg-surface pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]" onSubmit={(e) => { e.preventDefault(); reply.mutate(); }}><label htmlFor="portal-reply" className="text-sm font-medium">{t("portal.reply")}</label><Textarea id="portal-reply" name="body" maxLength={10000} value={body} onChange={(e) => setBody(e.target.value)} />{reply.isError && <Notice>{t("portal.error")}</Notice>}<Button className="self-end" variant="primary" type="submit" disabled={!body.trim() || reply.isPending}>{t("portal.send")}</Button></form></>}</>;
}
