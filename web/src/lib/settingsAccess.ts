// Who each settings page is for: the one table the settings nav and settings search read.
//   needs  what the workspace and instance must have for the page to be listed at all;
//   role   the least role that can change anything on it (search lists it from that role:
//          others see it read-only or not at all).
// A test keeps every route of the settings index in the table.

import { useQuery } from "@tanstack/react-query";
import type { Role } from "@/lib/api/types";
import type { Gate } from "@/lib/appSearch/types";
import { useCollab } from "@/lib/collab/hooks";
import { settingsProductAvailable, useProducts } from "@/lib/products";
import { q } from "@/lib/queries";
import { atLeast, useRole, useSession } from "@/lib/session";

export type SettingsNeed = "tickets" | "collab" | "ai" | "aiOrAdmin" | "admin" | "severalWorkspaces";

export interface SettingsRule {
  needs?: SettingsNeed[];
  role?: Role;
}

const AGENT: SettingsRule = { needs: ["admin", "ai"], role: "admin" };

export const SETTINGS_RULES: Record<string, SettingsRule> = {
  "/settings/profile": {},
  "/settings/security": {},
  "/settings/notifications": {},
  // Ollie asking a teammate's Ollie about their mail: Collab's, with AI.
  "/settings/agent-to-agent": { needs: ["collab", "ai"] },
  // Arranging workspaces needs two of them.
  "/settings/workspaces": { needs: ["severalWorkspaces"] },
  "/settings/shortcuts": {},
  "/settings/workspace": { role: "admin" },
  "/settings/members": {},
  "/settings/teams": {},
  "/settings/pages": { role: "agent" },
  "/settings/billing": { role: "admin" },
  // Admins always see AI: without a provider it explains how to connect one.
  "/settings/ai": { needs: ["aiOrAdmin"], role: "admin" },
  "/settings/integrations": { role: "admin" },
  "/settings/import": { role: "admin" },
  "/settings/tags": { role: "admin" },
  "/settings/custom-fields": { role: "admin" },
  "/settings/assignment": { role: "admin" },
  "/settings/triage": { role: "admin" },
  "/settings/business-hours": { role: "admin" },
  "/settings/saved-replies": { role: "agent" },
  "/settings/views": { role: "agent" },
  "/settings/sla": { role: "admin" },
  "/settings/automations": { role: "admin" },
  "/settings/mailboxes": { role: "admin" },
  "/settings/mailboxes/new": { role: "admin" },
  "/settings/phone": { role: "admin" },
  "/settings/support-channels": { role: "agent" },
  // Collab mail accounts are each member's own.
  "/settings/mail-accounts": { needs: ["collab"] },
  "/settings/mail-categories": { needs: ["collab"] },
  "/settings/routing": { role: "admin" },
  "/settings/brands": { role: "admin" },
  "/settings/email-design": { role: "admin" },
  "/settings/api-keys": { role: "admin" },
  "/settings/ai-clients": {},
  "/settings/webhooks": { role: "admin" },
  "/settings/audit-log": { role: "admin" },
  "/settings/trash": { role: "admin" },
  // Pages opened from a list: what one of them shows is found as the list's (indexer/settings.ts).
  "/settings/teams/$teamId": { role: "admin" },
  "/settings/brands/$brandId": { role: "admin" },
  "/settings/brands/$brandId/widgets/$widgetId": { role: "admin" },
  "/settings/mailboxes/$mailboxId": { role: "admin" },
  "/settings/mail-accounts/$accountId": { needs: ["collab"] },
  "/settings/routing/$ruleId": { role: "admin" },
  "/settings/automations/$automationId": { role: "admin" },
  "/settings/webhooks/$webhookId": { role: "admin" },
  "/settings/ai/bots/$botId": AGENT,
  // The AI agent: admins on an instance with AI.
  "/settings/ai/agent": AGENT,
  "/settings/ai/bots": AGENT,
  "/settings/ai/behaviour": AGENT,
  "/settings/ai/knowledge": AGENT,
  "/settings/ai/procedures": AGENT,
  "/settings/ai/tools": AGENT,
  "/settings/ai/playground": AGENT,
  "/settings/ai/tests": AGENT,
};

/** What the reader and their workspace have, for settings that depend on it. */
export interface SettingsAccess {
  role: Role;
  tickets: boolean;
  collab: boolean;
  /** The instance has an AI provider (true until that is known, as the nav assumes). */
  ai: boolean;
  /** Billing is on: opendesk Cloud. */
  cloud: boolean;
  severalWorkspaces: boolean;
}

function meets(need: SettingsNeed, a: SettingsAccess): boolean {
  switch (need) {
    case "tickets":
      return a.tickets;
    case "collab":
      return a.collab;
    case "ai":
      return a.ai;
    case "aiOrAdmin":
      return a.ai || atLeast(a.role, "admin");
    case "admin":
      return atLeast(a.role, "admin");
    case "severalWorkspaces":
      return a.severalWorkspaces;
  }
}

/** The settings nav lists the page. */
export function settingsListed(route: string, a: SettingsAccess): boolean {
  return settingsProductAvailable(route, { tickets: a.tickets, mail: a.collab }) && (SETTINGS_RULES[route]?.needs ?? []).every((n) => meets(n, a));
}

/** Settings search offers the page: it is listed and the reader can change something on it. */
export function settingsUsable(route: string, a: SettingsAccess): boolean {
  return route in SETTINGS_RULES && settingsListed(route, a) && atLeast(a.role, SETTINGS_RULES[route].role ?? "viewer");
}

/** The reader has a part of a page, given what the code shows it under (indexer/settings.ts). */
export function gatesMet(gates: readonly Gate[] | undefined, a: SettingsAccess): boolean {
  return (gates ?? []).every((g) => {
    switch (g) {
      case "admin":
        return atLeast(a.role, "admin");
      case "owner":
        return a.role === "owner";
      case "collab":
        return a.collab;
      case "tickets":
        return a.tickets;
      case "ai":
        return a.ai;
      case "cloud":
        return a.cloud;
      case "selfHosted":
        return !a.cloud;
    }
  });
}

/** The reader's SettingsAccess. `cloud` loads billing, so only search asks for it, and only for admins: what depends on it is theirs. */
export function useSettingsAccess(opts: { cloud?: boolean } = {}): SettingsAccess {
  const role = useRole();
  const { data: ai, isFetched } = useQuery(q.aiConfig());
  const collab = useCollab();
  const { tickets } = useProducts();
  const severalWorkspaces = useSession((s) => s.memberships.length > 1);
  const { data: billing } = useQuery({ ...q.billing(), enabled: !!opts.cloud && atLeast(role, "admin") });
  return { role, tickets, collab: collab.enabled, ai: !isFetched || !!ai?.enabled, cloud: !!billing?.billing_enabled, severalWorkspaces };
}
