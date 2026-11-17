// Shots for guides/collab/*.mdx. Run with the web app in VITE_MOCK=1 mode:
// node scripts/docs/shots.mjs scripts/docs/shots/collab.mjs
// Every state is reached through the demo UI. No real accounts or provider calls.
import { around, button, settle } from '../helpers.mjs';

const sidebar = (p) => p.getByRole('navigation', { name: 'Main', exact: true });
const conversation = (p) => p.getByRole('region', { name: 'Conversation', exact: true });
const section = (p, title) => p.locator('main section').filter({ has: p.getByRole('heading', { name: title, exact: true }) }).first();
const snoozeOff = (p) => conversation(p).getByRole('button', { name: /^Snooze:/ });

async function openAccount(page, name = 'Sales') {
  await sidebar(page).getByRole('link', { name: new RegExp(`^${name}`) }).click();
  await settle(page);
  await page.getByRole('heading', { name: `Inbox · ${name}`, exact: true }).waitFor();
}

async function openConversation(page, name = 'Sales') {
  await openAccount(page, name);
  await page.getByRole('option').first().click();
  await conversation(page).waitFor();
  await settle(page);
  const people = conversation(page).getByRole('button', { name: 'Hide people', exact: true });
  if (await people.count()) await people.click();
}

async function openSalesSettings(page) {
  await page.locator('main').getByRole('button', { name: /^Sales Shared sales@margin\.app/ }).click();
  await section(page, 'Sharing').waitFor();
  await settle(page);
}

async function reply(page) {
  await openConversation(page);
  await conversation(page).getByRole('button', { name: 'Reply', exact: true }).click();
  await conversation(page).getByRole('textbox', { name: 'Write your reply' }).fill('Thursday at 3pm works for us. Please share the design beforehand.');
  await settle(page);
}

export const shots = [
  {
    name: 'collab/overview',
    path: '/mail',
    highlight: [
      { target: (p) => sidebar(p).getByRole('button', { name: 'Compose', exact: true }), label: 1 },
      { target: (p) => ['Work', 'Personal', 'Sales'].map((name) => sidebar(p).getByRole('link', { name: new RegExp(`^${name}`) })), label: 2, inset: 5 },
      { target: (p) => p.getByRole('navigation', { name: 'Folders', exact: true }), label: 3 },
    ],
  },
  {
    name: 'collab/selection',
    path: '/mail',
    run: async (p) => {
      await openAccount(p);
      await p.getByRole('option').nth(0).hover();
      await p.getByRole('option').nth(0).getByRole('checkbox').click();
      await p.getByRole('option').nth(1).hover();
      await p.getByRole('option').nth(1).getByRole('checkbox').click();
      await settle(p);
    },
    clip: (p) => [p.getByRole('heading', { name: 'Inbox · Sales', exact: true }), p.getByRole('option').last()],
    highlight: [
      { target: (p) => p.getByRole('checkbox', { name: 'Clear selection', exact: true }), label: 1 },
      { target: (p) => p.getByRole('button', { name: 'Sync now', exact: true }), label: 2 },
      { target: (p) => p.getByRole('toolbar', { name: '2 selected', exact: true }), label: 3, inset: 2 },
    ],
  },
  {
    name: 'collab/handling',
    path: '/settings/mail-accounts',
    run: async (p) => {
      await openSalesSettings(p);
      await p.locator('#handling-enabled').click();
      await p.locator('#handling-mark-inbox').click();
      await p.getByRole('button', { name: 'Save', exact: true }).first().click();
      await settle(p);
      await sidebar(p).getByRole('link', { name: /^Needs action/ }).click();
      await settle(p);
      await p.getByRole('option').first().hover();
      await p.getByRole('option').first().getByRole('checkbox').click();
      await settle(p);
      await p.locator('[data-sonner-toast]').filter({ hasText: 'Saved' }).waitFor({ state: 'hidden' });
    },
    highlight: [
      { target: (p) => sidebar(p).getByRole('link', { name: /^Needs action/ }), label: 1 },
      { target: (p) => p.getByRole('button', { name: 'Mark as done', exact: true }).first(), label: 2 },
    ],
  },
  {
    name: 'collab/snooze-unavailable',
    path: '/mail',
    run: async (p) => {
      await openConversation(p, 'Work');
      // aria-disabled conveys unavailability, but this control intentionally opens its reason.
      await snoozeOff(p).click({ force: true });
      await settle(p);
    },
    clip: (p) => [snoozeOff(p), p.getByText('Snooze works on shared accounts with Handling on. Share the account and turn on Handling in its settings.', { exact: true }).last()],
    pad: 36,
    highlight: [
      { target: snoozeOff, label: 1 },
      { target: (p) => p.getByText('Snooze works on shared accounts with Handling on. Share the account and turn on Handling in its settings.', { exact: true }).last(), label: 2, inset: 6 },
    ],
  },
  {
    name: 'collab/conversation',
    path: '/mail',
    run: openConversation,
    clip: conversation,
    highlight: [
      { target: (p) => conversation(p).getByRole('button', { name: 'Reply', exact: true }), label: 1 },
      { target: (p) => conversation(p).getByRole('button', { name: 'Forward', exact: true }), label: 2 },
      { target: (p) => conversation(p).getByRole('button', { name: 'Comment', exact: true }), label: 3 },
    ],
  },
  {
    name: 'collab/composer',
    path: '/mail',
    run: reply,
    clip: conversation,
    highlight: [
      { target: (p) => p.locator('[aria-label="Choose whether to reply to the sender or comment for your team"]'), label: 1 },
      { target: (p) => [conversation(p).getByText('sales@margin.app', { exact: true }).last(), conversation(p).getByRole('combobox', { name: 'To', exact: true }).locator('xpath=../..')], label: 2 },
      { target: (p) => conversation(p).getByRole('button', { name: 'Send', exact: true }), label: 3 },
    ],
  },
  {
    name: 'collab/undo-send',
    path: '/mail',
    run: async (p) => {
      await reply(p);
      await conversation(p).getByRole('button', { name: 'Send', exact: true }).click();
      await p.getByRole('button', { name: 'Send now', exact: true }).waitFor();
    },
    clip: (p) => p.locator('[data-sonner-toast]').filter({ hasText: 'Sending' }),
    pad: 32,
    highlight: [
      { target: (p) => p.getByRole('button', { name: 'Undo', exact: true }), label: 1 },
      { target: (p) => p.getByRole('button', { name: 'Send now', exact: true }), label: 2 },
    ],
  },
  {
    name: 'collab/connect',
    path: '/settings/mail-accounts',
    run: async (p) => {
      await p.getByRole('button', { name: 'Connect an account', exact: true }).click();
      await settle(p);
    },
    clip: '[role="dialog"]',
    highlight: [{ target: (p) => around(p, 'Google Workspace', 'Microsoft 365', 'Any server with IMAP and SMTP'), label: 1 }],
  },
  {
    name: 'collab/sharing',
    path: '/settings/mail-accounts',
    run: async (p) => {
      await openSalesSettings(p);
      await section(p, 'Sharing').scrollIntoViewIfNeeded();
      await settle(p);
    },
    clip: (p) => section(p, 'Sharing'),
    pad: 28,
    highlight: [{ target: (p) => section(p, 'Sharing'), label: 1 }],
  },
  {
    name: 'collab/products',
    path: '/settings/workspace',
    run: async (p) => {
      await p.getByRole('switch', { name: 'Tickets', exact: true }).click();
      await section(p, 'Products').evaluate((el) => el.scrollIntoView({ block: 'center' }));
      await settle(p);
    },
    clip: (p) => [section(p, 'Products'), button(p, 'Save changes')],
    highlight: [
      { target: (p) => section(p, 'Products'), label: 1 },
      { target: (p) => button(p, 'Save changes'), label: 2 },
    ],
  },
].map((shot) => ({
  ...shot,
  run: async (page) => {
    if (!(await page.evaluate(() => !!window.__odMock))) throw new Error('Collab docs shots require VITE_MOCK=1 demo data');
    const dismiss = page.getByRole('button', { name: 'Not now', exact: true });
    if (await dismiss.count()) await dismiss.first().click();
    const tip = sidebar(page).getByRole('button', { name: 'Dismiss', exact: true });
    if (await tip.count()) await tip.click();
    const tickets = sidebar(page).getByRole('button', { name: 'Tickets', exact: true, expanded: true });
    if (await tickets.count()) await tickets.click();
    await shot.run?.(page);
  },
}));
