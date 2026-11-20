import { describe, expect, it } from "vitest";
import type { MailAccount, MailAccountCategories, MailCategory, MailCounts } from "../api/types";
import { accountCategories, movableToCategory, categoryOrderSet, categoryProblem, categoryTabs, categoryTone, inKeyOrder, moveCategory, ruleSender, showsOrderSet, slugKey, withKeys } from "./categories";

const cat = (key: string, name = key[0].toUpperCase() + key.slice(1), color: MailCategory["color"] = "gray"): MailCategory => ({ key, name, description: "", color });

function account(id: string, categories: MailCategory[] | null): MailAccount {
  const c: MailAccountCategories = {
    engine: "local",
    enabled: !!categories,
    categories: categories ?? [],
    source: categories ? "workspace" : "none",
    team: null,
    mode: "follow",
    own: [],
    ai: true,
    locked: false,
  };
  return { id, categories: c } as MailAccount;
}

const counts = (p: Partial<MailCounts>): MailCounts => ({ boxes: { inbox: 0, unread: 0, shared: 0, assigned: 0, drafts: 0, needs_action: 0 }, accounts: {}, folders: {}, assigned: {}, ...p });

describe("categoryTabs", () => {
  it("is empty while no account in view is split", () => {
    expect(categoryTabs([account("a", null), account("b", null)])).toEqual([]);
  });

  it("keeps a set's own order when it was reordered, even when an account on the default is listed first (hob1)", () => {
    const defaults = [cat("primary"), cat("updates"), cat("newsletters"), cat("promotions")];
    const shared = account("shared", defaults);
    const mine = account("mine", [cat("primary"), cat("codes", "Codes / Logins"), cat("updates"), cat("newsletters"), cat("tech", "Tech Updates"), cat("promotions")]);
    expect(categoryTabs([shared, mine]).map((t) => t.key)).toEqual(["primary", "codes", "updates", "newsletters", "tech", "promotions"]);
    expect(categoryTabs([mine, shared]).map((t) => t.key)).toEqual(["primary", "codes", "updates", "newsletters", "tech", "promotions"]);
  });

  it("follows the order most accounts share, ties going to the first account, with its names", () => {
    const a = account("a", [cat("primary"), cat("updates"), cat("promotions")]);
    const b = account("b", [cat("primary"), cat("promotions", "Deals"), cat("updates")]);
    const c = account("c", [cat("primary"), cat("promotions", "Deals"), cat("updates")]);
    const tabs = categoryTabs([a, b, c]);
    expect(tabs.map((t) => t.key)).toEqual(["primary", "promotions", "updates"]);
    expect(tabs[1].name).toBe("Deals");
    expect(categoryTabs([a, b]).map((t) => t.key)).toEqual(["primary", "updates", "promotions"]);
  });

  it("puts another account's own categories after the one they follow in that account, with the first account's name for a shared key", () => {
    const work = account("w", [cat("primary", "Important", "blue"), cat("updates"), cat("clients", "Clients", "green")]);
    const sales = account("s", [cat("primary"), cat("leads"), cat("updates", "Robots")]);
    const tabs = categoryTabs([work, sales]);
    expect(tabs.map((t) => t.key)).toEqual(["primary", "leads", "updates", "clients"]);
    expect(tabs[0].name).toBe("Important");
    expect(tabs.find((t) => t.key === "updates")?.name).toBe("Updates");
  });

  it("sums each tab's unread conversations, and counts an account that is not split under Primary", () => {
    const work = account("w", [cat("primary"), cat("updates")]);
    const sales = account("s", [cat("primary"), cat("updates"), cat("newsletters")]);
    const personal = account("p", null);
    const c = counts({ accounts: { w: 9, s: 9, p: 4 }, categories: { w: { primary: 2, updates: 3 }, s: { primary: 1, newsletters: 5 } } });
    const tabs = categoryTabs([work, sales, personal], c);
    expect(Object.fromEntries(tabs.map((t) => [t.key, t.unread]))).toEqual({ primary: 2 + 1 + 4, updates: 3, newsletters: 5 });
  });

  it("leaves out an account with one category", () => {
    expect(categoryTabs([account("a", [cat("primary")])])).toEqual([]);
  });
});

describe("withKeys", () => {
  it("keeps Primary's key on the first, makes the others from their names and never repeats one", () => {
    const out = withKeys([cat("", "Important"), cat("", "Sales leads"), cat("", "Sales  leads!"), cat("primary", "Not primary"), cat("updates")]);
    expect(out.map((c) => c.key)).toEqual(["primary", "sales-leads", "sales-leads-2", "category", "updates"]);
  });

  it("falls back to a plain key for a name with no letters or digits", () => {
    expect(withKeys([cat("primary"), cat("", "★★")])[1].key).toBe("category");
  });
});

describe("slugKey", () => {
  it("lower-cases, joins words with dashes and stops at 36 characters", () => {
    expect(slugKey("  Clients & Partners ")).toBe("clients-partners");
    expect(slugKey("x".repeat(50))).toHaveLength(36);
  });
});

describe("categoryProblem", () => {
  it("needs 2 to 10 categories", () => {
    expect(categoryProblem([cat("primary")])).toBe("count");
    expect(categoryProblem(Array.from({ length: 11 }, (_, i) => cat(`c${i}`)))).toBe("count");
    expect(categoryProblem([cat("primary"), cat("updates")])).toBeNull();
  });

  it("needs a name of up to 40 characters on each", () => {
    expect(categoryProblem([cat("primary"), cat("x", "   ")])).toBe("name");
    expect(categoryProblem([cat("primary"), cat("x", "y".repeat(41))])).toBe("name");
  });

  it("refuses two names that differ only in case or spaces", () => {
    expect(categoryProblem([cat("primary", "Primary"), cat("x", " primary ")])).toBe("repeat");
  });
});

describe("ruleSender", () => {
  it("names the first participant who is not one of the account's addresses, in lower case", () => {
    const own = new Set(["me@margin.app"]);
    expect(ruleSender([{ email: "ME@margin.app" }, { email: "Ana@Acme.com" }], own)).toBe("ana@acme.com");
    expect(ruleSender([{ email: "me@margin.app" }], own)).toBeNull();
    expect(ruleSender([{ email: "" }], own)).toBeNull();
  });
});

describe("accountCategories and categoryTone", () => {
  it("offers an account's categories only while its inbox is split", () => {
    expect(accountCategories(account("a", [cat("primary"), cat("updates")])).map((c) => c.key)).toEqual(["primary", "updates"]);
    expect(accountCategories(account("a", null))).toEqual([]);
    expect(accountCategories(undefined)).toEqual([]);
  });

  it("reads an unknown colour as grey", () => {
    expect(categoryTone({ color: "violet" })).toBe("violet");
    expect(categoryTone({ color: "chartreuse" as MailCategory["color"] })).toBe("gray");
  });
});

describe("movableToCategory", () => {
  const work = account("w", [cat("primary"), cat("codes-logins"), cat("updates")]);
  const sales = account("s", [cat("primary"), cat("updates")]);
  const plain = account("p", null);
  const byId = new Map([work, sales, plain].map((a) => [a.id, a]));
  const t = (id: string, account_id: string) => ({ id, account_id });

  it("takes the conversations whose account has the category", () => {
    expect(movableToCategory([t("1", "w"), t("2", "s")], byId, "updates").map((x) => x.id)).toEqual(["1", "2"]);
    expect(movableToCategory([t("1", "w")], byId, "codes-logins").map((x) => x.id)).toEqual(["1"]);
  });

  it("moves those of an account with a category of its own when others in the drag lack it", () => {
    // An inbox spanning accounts shows one account's own category as a tab for every account.
    expect(movableToCategory([t("1", "s"), t("2", "w"), t("3", "s")], byId, "codes-logins").map((x) => x.id)).toEqual(["2"]);
  });

  it("leaves those whose account lacks it, is not split or is unknown", () => {
    expect(movableToCategory([t("1", "s")], byId, "codes-logins")).toEqual([]);
    expect(movableToCategory([t("1", "p")], byId, "primary")).toEqual([]);
    expect(movableToCategory([t("1", "gone")], byId, "updates")).toEqual([]);
    expect(movableToCategory([], byId, "updates")).toEqual([]);
  });
});

describe("categoryOrderSet", () => {
  const defaults = [cat("primary"), cat("updates"), cat("promotions")];
  const teamSet = [cat("primary"), cat("promotions"), cat("social")];
  const mine = (c: Partial<MailAccountCategories> = {}, id = "mine") => {
    const a = account(id, defaults);
    return { ...a, can_manage: true, categories: { ...a.categories, ...c } } as MailAccount;
  };
  const onTeam = (id: string, team = "sales") => mine({ categories: teamSet, source: "team", team: { id: team, name: team } }, id);

  it("is the caller's own account when it is the one split account in view, whether it follows a set or has its own", () => {
    const following = mine();
    const set = categoryOrderSet([following], following);
    expect(set).toEqual({ kind: "account", account: following, categories: defaults });
    expect(showsOrderSet(following, set!)).toBe(true);
    const own = mine({ mode: "custom", source: "account", own: defaults });
    expect(categoryOrderSet([own, account("whole", null)], own)?.kind).toBe("account");
  });

  it("refuses an account locked for the caller, on Gmail's fixed set, not theirs, or sharing the tabs with another split account", () => {
    const locked = mine({ locked: true });
    expect(categoryOrderSet([locked], locked)).toBeNull();
    const gmail = mine({ mode: "gmail", engine: "gmail", source: "account" });
    expect(categoryOrderSet([gmail], gmail)).toBeNull();
    const shared = { ...mine(), can_manage: false } as MailAccount;
    expect(categoryOrderSet([shared], shared)).toBeNull();
    const own = mine();
    expect(categoryOrderSet([own, mine({}, "other")], own)).toBeNull();
    expect(categoryOrderSet([own], null)).toBeNull();
  });

  it("is the workspace default for an admin when every split account in view follows it", () => {
    const set = categoryOrderSet([mine({}, "a"), mine({}, "b"), account("whole", null)], "workspace");
    expect(set).toEqual({ kind: "workspace", categories: defaults });
    expect(showsOrderSet(onTeam("t"), set!)).toBe(false);
    expect(showsOrderSet(mine({ mode: "custom", source: "account" }), set!)).toBe(false);
  });

  it("is a team's set for an admin when every split account in view follows that team", () => {
    const set = categoryOrderSet([onTeam("a"), onTeam("b")], "workspace");
    expect(set).toEqual({ kind: "team", team: "sales", categories: teamSet });
    expect(showsOrderSet(onTeam("c", "support"), set!)).toBe(false);
  });

  it("has no set for an admin when the tabs merge several sets or one is an account's own", () => {
    expect(categoryOrderSet([mine({}, "a"), onTeam("b")], "workspace")).toBeNull();
    expect(categoryOrderSet([onTeam("a"), onTeam("b", "support")], "workspace")).toBeNull();
    expect(categoryOrderSet([mine({ mode: "custom", source: "account" })], "workspace")).toBeNull();
  });
});

describe("inKeyOrder", () => {
  const list = [cat("primary"), cat("updates"), cat("promotions")];

  it("puts a set in the keys' order", () => {
    expect(inKeyOrder(list, ["primary", "promotions", "updates"])?.map((c) => c.key)).toEqual(["primary", "promotions", "updates"]);
  });

  it("refuses an order with Primary anywhere but first, or keys that are not the set's", () => {
    expect(inKeyOrder(list, ["updates", "primary", "promotions"])).toBeNull();
    expect(inKeyOrder(list, ["primary", "updates"])).toBeNull();
    expect(inKeyOrder(list, ["primary", "updates", "updates"])).toBeNull();
    expect(inKeyOrder(list, ["primary", "updates", "social"])).toBeNull();
  });
});

describe("moveCategory", () => {
  const keys = ["primary", "updates", "promotions", "social"];

  it("moves a category one place either way", () => {
    expect(moveCategory(keys, "promotions", -1)).toEqual(["primary", "promotions", "updates", "social"]);
    expect(moveCategory(keys, "updates", 1)).toEqual(["primary", "promotions", "updates", "social"]);
  });

  it("keeps Primary first: it does not move and nothing moves before it", () => {
    expect(moveCategory(keys, "primary", 1)).toBeNull();
    expect(moveCategory(keys, "updates", -1)).toBeNull();
    expect(moveCategory(keys, "social", 1)).toBeNull();
    expect(moveCategory(keys, "missing", 1)).toBeNull();
  });
});
