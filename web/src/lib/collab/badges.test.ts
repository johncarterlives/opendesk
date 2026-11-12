import { describe, expect, it } from "vitest";
import type { MailAccount, MailCounts } from "@/lib/api/types";
import { handlingSpam } from "./badges";

const account = (id: string, visibility: "shared" | "private", handling_enabled: boolean) => ({ id, visibility, handling_enabled }) as MailAccount;
const counts = (spam: Record<string, number>) =>
  ({ boxes: { inbox: 0, unread: 0, shared: 0, assigned: 0, drafts: 0, needs_action: 0, spam: Object.values(spam).reduce((s, n) => s + n, 0) }, accounts: {}, folders: {}, spam }) as MailCounts;

describe("handlingSpam", () => {
  it("opens the one handling account's Spam with its number", () => {
    const accounts = [account("a", "shared", true), account("b", "shared", false)];
    expect(handlingSpam(accounts, counts({ a: 2, b: 5 }))).toEqual({ n: 2, account: "a" });
  });

  it("counts only shared handling accounts when several have spam", () => {
    const accounts = [account("a", "shared", true), account("b", "shared", true), account("c", "private", false), account("d", "shared", false)];
    expect(handlingSpam(accounts, counts({ a: 2, b: 3, c: 40, d: 7 }))).toEqual({ n: 5 });
  });

  it("ignores spam outside handling accounts", () => {
    expect(handlingSpam([account("c", "private", false)], counts({ c: 4 }))).toEqual({ n: 0 });
  });
});
