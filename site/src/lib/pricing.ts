/*
 * Plans and AI usage, from contracts/billing.md. Prices render on /pricing, the
 * home page teaser and the JSON-LD offers; nothing else hard-codes a price.
 *
 * The yearly prices are not decided, so the site shows monthly pricing only.
 */
import { LINKS } from './site';

export const PRO_PRICE = 18; // USD per seat per month, billed monthly
export const COLLAB_PRICE = 38; // USD per seat per month, billed monthly: Pro plus Collab

// The monthly AI usage allowance, in US dollars (contracts/billing.md, "Plans"):
// per paid seat on Pro and on Collab, pooled across the workspace.
export const AI_ALLOWANCE = { free: 0.5, perSeat: 10, collabPerSeat: 20 };

// Collab mail storage per paid seat, pooled, a fair-use bound (contracts/billing.md "Collab").
export const COLLAB_STORAGE_GB = 25;

// An AI top-up: a one-time purchase of any amount of AI usage, dollar for dollar.
// Top-ups never expire and are spent after the monthly allowance.
export const AI_TOP_UP = { minUsd: 5, maxUsd: 5000 };

// Auto-recharge defaults: off, and when on, $25 when the balance falls below $5,
// up to $250 a month.
export const AUTO_RECHARGE = { thresholdUsd: 5, amountUsd: 25, monthlyLimitUsd: 250 };

export type Plan = {
  id: 'free' | 'pro' | 'collab' | 'self_hosted';
  name: string;
  blurb: string;
  price: string;
  unit: string;
  note: string;
  cta: { label: string; href: string };
  featured?: boolean;
  limits: string[];
};

export const PLANS: Plan[] = [
  {
    id: 'free',
    name: 'Free',
    blurb: 'For a founder or a one-person support desk. Free forever, for any organization.',
    price: '$0',
    unit: 'forever',
    note: 'Per workspace',
    cta: { label: 'Start for free', href: LINKS.signup },
    limits: ['1 mailbox', '1 team member', '$0.50 of AI usage per month', 'Every helpdesk feature'],
  },
  {
    id: 'pro',
    name: 'Pro',
    blurb: 'For teams. Everything unlimited, billed for the people who answer customers.',
    price: `$${PRO_PRICE}`,
    unit: 'per user / month',
    note: 'Viewers are free',
    cta: { label: 'Start for free', href: LINKS.signup },
    featured: true,
    limits: ['Unlimited mailboxes', 'Unlimited team members', `$${AI_ALLOWANCE.perSeat} of AI usage per seat per month, pooled`, 'Every helpdesk feature'],
  },
  {
    id: 'collab',
    name: 'Collab',
    blurb: 'Pro, plus each person’s own mail in opendesk: private, or shared with the team.',
    price: `$${COLLAB_PRICE}`,
    unit: 'per user / month',
    note: 'Viewers are free',
    cta: { label: 'Start for free', href: LINKS.signup },
    limits: ['Everything in Pro', 'Your own Google, Microsoft or IMAP mail, synced both ways', `$${AI_ALLOWANCE.collabPerSeat} of AI usage per seat per month, pooled`, `${COLLAB_STORAGE_GB} GB of mail per seat, pooled`],
  },
  {
    id: 'self_hosted',
    name: 'Self-hosted',
    blurb: 'Run it on your own servers, with your own AI key or a local model.',
    price: '$0',
    unit: 'free, unlimited',
    note: 'Apache-2.0',
    cta: { label: 'Read the install guide', href: 'https://docs.opendesk.sh/getting-started/quickstart-self-host/' },
    limits: ['Unlimited mailboxes', 'Unlimited team members', 'Unlimited AI with your own key', 'Every feature, Collab included'],
  },
];

// opendesk Cloud charges each AI call its provider cost times this markup
// (AI_USAGE_MARKUP, contracts/billing.md "Metered usage"). Own key: $0.
export const AI_MARKUP = 1.5;

// A typical draft reply, the size GET /v1/ai/models prices typical_reply_usd on.
export const TYPICAL_DRAFT = { input: 4000, output: 500 };

type ModelPrice = { id: string; name: string; vendor: string; input: number; output: number; note?: string };

// The default models a workspace can choose from, with the provider's list price in US
// dollars per 1M input / output tokens. Source: OpenRouter (GET /api/v1/models), as of
// 2026-10-18. Prices follow the provider's list price, so update them when it changes.
const RAW_MODELS: ModelPrice[] = [
  { id: 'anthropic/claude-sonnet-5.5', name: 'Claude Sonnet 5.5', vendor: 'Anthropic', input: 2, output: 10 },
  { id: 'anthropic/claude-haiku-5.5', name: 'Claude Haiku 5.5', vendor: 'Anthropic', input: 0.1, output: 0.5, note: 'Default' },
  { id: 'anthropic/claude-opus-5.5', name: 'Claude Opus 5.5', vendor: 'Anthropic', input: 4, output: 20 },
  { id: 'openai/gpt-5.6-sol', name: 'GPT-5.6 Sol', vendor: 'OpenAI', input: 4, output: 20 },
  { id: 'openai/gpt-5.6-luna', name: 'GPT-5.6 Luna', vendor: 'OpenAI', input: 0.2, output: 1.2 },
  { id: 'google/gemini-3.8-flash', name: 'Gemini 3.8 Flash', vendor: 'Google', input: 0.825, output: 4.125 },
  { id: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', vendor: 'DeepSeek', input: 0.065, output: 0.144 },
  { id: 'z-ai/glm-5.3-flash', name: 'GLM-5.3 Flash', vendor: 'Z.ai', input: 0.048, output: 0.2, note: 'Fast' },
];

// Rounds a dollar amount to the micro-dollar, as amounts are kept.
const micro = (usd: number) => Math.round(usd * 1e6) / 1e6;

export type Model = ModelPrice & {
  /** US dollars per 1M input / output tokens as a Cloud workspace pays them. */
  pays: { input: number; output: number };
  /** What a typical draft reply costs on this model, as a Cloud workspace pays it. */
  typicalDraft: number;
};

/** What a call of this size costs a Cloud workspace on a model, in US dollars. */
export const callCost = (m: Pick<ModelPrice, 'input' | 'output'>, input: number, output: number) =>
  micro(((input * m.input + output * m.output) / 1e6) * AI_MARKUP);

export const MODELS: Model[] = RAW_MODELS.map((m) => ({
  ...m,
  pays: { input: micro(m.input * AI_MARKUP), output: micro(m.output * AI_MARKUP) },
  typicalDraft: callCost(m, TYPICAL_DRAFT.input, TYPICAL_DRAFT.output),
}));

export const model = (id: string): Model => {
  const m = MODELS.find((x) => x.id === id);
  if (!m) throw new Error(`unknown model ${id}`);
  return m;
};

/** A balance or allowance: "$0.50", "$10", "$1,234.56". */
export const usd = (n: number, cents = !Number.isInteger(n)) =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: 2 })}`;

/** A per-call amount, to the hundredth of a cent: "$0.0195", "<$0.0001". */
export const usdCall = (n: number) =>
  n > 0 && n < 0.00005 ? '<$0.0001' : `$${n.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 })}`;

/** A price per 1M tokens: "$3", "$0.15", "$1.125". */
export const usdPerMTok = (n: number) =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 3 })}`;
