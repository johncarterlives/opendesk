import { describe, expect, it } from "vitest";
import type { Space, SpaceItem } from "../api/types";
import { defaultSidebarPrefs } from "../collab/sidebarPrefs";
import { arrangedPrefs, arrangeRows, canMoveRow, itemOfKey, moveRow, resetArranged, setRowHidden, stepRow, type Layout } from "./arrange";
import { forWire, itemKey, normalizeSpace, spaceProblems } from "./model";

const W = "11111111-1111-4111-8111-111111111111";
const V = "22222222-2222-4222-8222-222222222222";
const T1 = "33333333-3333-4333-8333-333333333333";
const T2 = "44444444-4444-4444-8444-444444444444";
const A1 = "55555555-5555-4555-8555-555555555555";

const whole = (id: string, p: Partial<SpaceItem> = {}, wid = W): SpaceItem => ({ workspace_id: wid, kind: "section", id, ...p });
const G = (id: string, wid = W) => itemKey(whole(id, {}, wid));

/** A starter as the editor first makes it: one untitled section of the workspace's whole sections. */
function starter(items: SpaceItem[] = [whole("favorites"), whole("inbox"), whole("mail"), whole("teams"), whole("workspace")]): Space {
  return { id: "s", name: "Lumen", icon: "", color: "blue", marks: true, sections: [{ id: "main", title: "", collapsed: false, items }, { id: "mine", title: "Mine", collapsed: false, items: [] }] };
}

/** What each group shows, as the editor lays it out (the rows each section has, arranged). */
const LIVE: Record<string, string[]> = {
  favorites: [],
  inbox: ["row:waiting_chats", "ticket_folder:unassigned", "ticket_folder:mine", "ticket_folder:open"],
  mail: ["box:inbox", "box:shared", "box:assigned", `account:${A1}`],
  teams: ["team:mine", `team:${T1}`, `team:${T2}`],
  workspace: ["page:contacts", "page:knowledge", "page:wiki"],
};
function layoutOf(s: Space): Layout {
  const out: Layout = s.sections.map((sec) => ({ key: sec.id, keys: sec.items.map(itemKey) }));
  for (const sec of s.sections)
    for (const i of sec.items) if (i.kind === "section") out.push({ key: itemKey(i), keys: arrangeRows(i.id as never, LIVE[i.id] ?? [], i) });
  return out;
}
const shownIn = (s: Space) => (c: string) => layoutOf(s).find((x) => x.key === c)?.keys ?? [];
const group = (s: Space, id: string) => s.sections.flatMap((x) => x.items).find((i) => i.kind === "section" && i.id === id)!;

describe("arranging a whole section in a Space", () => {
  it("adds Assigned to me to the top of Favorites and keeps it in Mail", () => {
    const s = starter();
    expect(canMoveRow(s, G("mail"), "box:assigned", G("favorites"))).toBe(true);
    const next = moveRow(s, G("mail"), "box:assigned", G("favorites"), null, shownIn(s))!;
    expect(group(next, "favorites").rows).toEqual(["box:assigned"]);
    expect(group(next, "mail").hidden).toBeUndefined();
    expect(shownIn(next)(G("mail"))).toContain("box:assigned");
    // Already a favorite: adding it again does nothing.
    expect(canMoveRow(next, G("mail"), "box:assigned", G("favorites"))).toBe(false);
    expect(moveRow(next, G("mail"), "box:assigned", G("favorites"), null, shownIn(next))).toBeNull();
    // A second favorite lands on top, before it.
    const two = moveRow(next, G("inbox"), "ticket_folder:mine", G("favorites"), "box:assigned", shownIn(next))!;
    expect(group(two, "favorites").rows).toEqual(["ticket_folder:mine", "box:assigned"]);
  });

  it("still shows Assigned to me in Mail once it is taken out of Favorites", () => {
    const s = starter();
    const fav = moveRow(s, G("mail"), "box:assigned", G("favorites"), null, shownIn(s))!;
    const out = setRowHidden(fav, G("favorites"), "box:assigned", true);
    expect(group(out, "favorites").rows).toBeUndefined();
    expect(group(out, "mail")).toEqual(whole("mail"));
    expect(shownIn(out)(G("mail"))).toContain("box:assigned");
    // Favorites take no row back into a built-in section: the X takes it out.
    expect(canMoveRow(fav, G("favorites"), "box:assigned", G("mail"))).toBe(false);
  });

  it("shows the Space's favorites before the person's own, and its hidden rows hidden", () => {
    const p = { ...defaultSidebarPrefs(), pinned: [{ kind: "view" as const, id: V }, { kind: "box" as const, id: "assigned" }], hidden: [`team:${T1}`], show_waiting_chats: true };
    const fav = arrangedPrefs(p, "favorites", { rows: ["box:assigned", "ticket_folder:mine"] });
    expect(fav.pinned.map((x) => `${x.kind}:${x.id}`)).toEqual(["box:assigned", "ticket_folder:mine", `view:${V}`]);
    const mail = arrangedPrefs(p, "mail", { hidden: ["box:assigned"] });
    expect(mail.hidden).toEqual([`team:${T1}`, "box:assigned"]);
    expect(arrangedPrefs(p, "inbox", { hidden: ["row:waiting_chats"] }).show_waiting_chats).toBe(false);
    // Not arranged: the person's own prefs, untouched.
    expect(arrangedPrefs(p, "mail", {})).toBe(p);
  });

  it("reorders the rows inside a section and keeps the section up to date", () => {
    const s = starter();
    const next = moveRow(s, G("teams"), `team:${T2}`, G("teams"), "team:mine", shownIn(s))!;
    expect(group(next, "teams").rows).toEqual([`team:${T2}`, "team:mine", `team:${T1}`]);
    // A team made later follows the order.
    expect(arrangeRows("teams", [...LIVE.teams, "team:new"], group(next, "teams"))).toEqual([`team:${T2}`, "team:mine", `team:${T1}`, "team:new"]);
    // The order reaches the sidebar through the member's row order, the Space's first.
    const p = { ...defaultSidebarPrefs(), row_order: { teams: [`team:${T1}`] } };
    expect(arrangedPrefs(p, "teams", group(next, "teams")).row_order.teams).toEqual([`team:${T2}`, "team:mine", `team:${T1}`]);
  });

  it("keeps Mail's boxes in their place: only accounts take one", () => {
    const s = starter();
    expect(canMoveRow(s, G("mail"), "box:shared", G("mail"))).toBe(false);
    expect(canMoveRow(s, G("mail"), `account:${A1}`, G("mail"))).toBe(true);
    expect(arrangeRows("mail", LIVE.mail, { rows: [`account:${A1}`, "box:inbox"] })).toEqual(LIVE.mail);
    // Views follow the workspace's own order: no order of the Space's.
    expect(canMoveRow(starter([whole("views")]), G("views"), `view:${V}`, G("views"))).toBe(false);
  });

  it("hides and shows one row, and takes a favorite out", () => {
    const s = starter();
    const hidden = setRowHidden(s, G("inbox"), "ticket_folder:open", true);
    expect(group(hidden, "inbox").hidden).toEqual(["ticket_folder:open"]);
    expect(group(setRowHidden(hidden, G("inbox"), "ticket_folder:open", false), "inbox").hidden).toBeUndefined();
    const fav = moveRow(s, G("mail"), "box:assigned", G("favorites"), null, shownIn(s))!;
    expect(group(setRowHidden(fav, G("favorites"), "box:assigned", true), "favorites").rows).toBeUndefined();
    expect(group(resetArranged(fav, G("mail")), "mail")).toEqual(whole("mail"));
  });

  it("adds a row to a section of the Space as a row of its own and keeps it in its home section", () => {
    const s = starter();
    const out = moveRow(s, G("teams"), `team:${T1}`, "mine", null, shownIn(s))!;
    expect(out.sections[1].items).toEqual([{ workspace_id: W, kind: "team", id: T1 }]);
    expect(group(out, "teams")).toEqual(whole("teams"));
    expect(shownIn(out)(G("teams"))).toContain(`team:${T1}`);
    // Already there: adding it again does nothing.
    expect(canMoveRow(out, G("teams"), `team:${T1}`, "mine")).toBe(false);
    // The Space row back into Teams stops being a row of its own, at the place it lands.
    const key = itemKey({ workspace_id: W, kind: "team", id: T1 });
    expect(canMoveRow(out, "mine", key, G("mail"))).toBe(false);
    const back = moveRow(out, "mine", key, G("teams"), "team:mine", shownIn(out))!;
    expect(back.sections[1].items).toEqual([]);
    expect(group(back, "teams").hidden).toBeUndefined();
    expect(group(back, "teams").rows).toEqual([`team:${T1}`, "team:mine", `team:${T2}`]);
  });

  it("keeps a Space row where it is when it is added to Favorites", () => {
    const s = starter();
    const out = moveRow(s, G("teams"), `team:${T1}`, "mine", null, shownIn(s))!;
    const key = itemKey({ workspace_id: W, kind: "team", id: T1 });
    const fav = moveRow(out, "mine", key, G("favorites"), null, shownIn(out))!;
    expect(group(fav, "favorites").rows).toEqual([`team:${T1}`]);
    expect(fav.sections[1].items).toEqual([{ workspace_id: W, kind: "team", id: T1 }]);
  });

  it("refuses what can't go: a row of another workspace, a part with no row of its own, a whole section into a group", () => {
    const other = "66666666-6666-4666-8666-666666666666";
    const s = starter([whole("favorites"), whole("mail", {}, other), whole("inbox")]);
    expect(canMoveRow(s, G("mail", other), "box:assigned", G("favorites"))).toBe(false);
    expect(canMoveRow(s, G("inbox"), "row:waiting_chats", "mine")).toBe(false);
    expect(itemOfKey(W, "pages:trash")).toBeNull();
    expect(canMoveRow(s, "main", G("inbox"), G("favorites"))).toBe(false);
    expect(canMoveRow(s, "main", G("inbox"), "mine")).toBe(true);
    expect(moveRow(s, G("inbox"), "ticket_folder:mine", G("mail", other), null, shownIn(s))).toBeNull();
  });

  it("walks a row up and down with the arrow keys, never adding it anywhere", () => {
    const s = starter();
    // A row of a whole section moves within it, and at its top or bottom goes nowhere.
    expect(stepRow(s, G("teams"), `team:${T1}`, -1, layoutOf(s))).toEqual({ to: G("teams"), before: "team:mine" });
    expect(stepRow(s, G("teams"), "team:mine", -1, layoutOf(s))).toBeNull();
    // Mail's boxes keep their place, and the arrow keys copy them nowhere, Favorites included.
    expect(stepRow(s, G("mail"), "box:inbox", -1, layoutOf(s))).toBeNull();
    expect(stepRow(s, G("mail"), "box:assigned", 1, layoutOf(s))).toBeNull();
    // A row of its own walks the Space's sections, past the whole sections' rows.
    const own = moveRow(s, G("teams"), `team:${T1}`, "main", G("teams"), shownIn(s))!;
    const key = itemKey({ workspace_id: W, kind: "team", id: T1 });
    expect(stepRow(own, "main", key, 1, layoutOf(own))).toEqual({ to: "main", before: G("workspace") });
    expect(stepRow(own, "main", key, -1, layoutOf(own))).toEqual({ to: "main", before: G("mail") });
    // At the very end, nowhere further.
    const last = moveRow(s, G("workspace"), "page:wiki", "mine", null, shownIn(s))!;
    expect(stepRow(last, "mine", itemKey({ workspace_id: W, kind: "page", id: "wiki" }), 1, layoutOf(last))).toBeNull();
  });
});

describe("a Space's arranged sections on the wire", () => {
  it("reads and sends rows and hidden on whole sections, and reads Spaces saved before them", () => {
    const s = normalizeSpace({
      id: "x",
      name: "Lumen",
      sections: [{ id: "main", items: [whole("mail", { rows: [`account:${A1}`, `account:${A1}`], hidden: ["box:assigned", 3] } as never), { workspace_id: W, kind: "team", id: T1, rows: ["x"] }] }],
    })!;
    expect(s.sections[0].items[0]).toEqual(whole("mail", { rows: [`account:${A1}`], hidden: ["box:assigned"] }));
    expect(s.sections[0].items[1]).toEqual({ workspace_id: W, kind: "team", id: T1 });
    expect(forWire(s).sections[0].items[0]).toEqual(whole("mail", { rows: [`account:${A1}`], hidden: ["box:assigned"] }));
    const old = normalizeSpace({ id: "x", name: "Lumen", sections: [{ id: "main", items: [whole("mail")] }] })!;
    expect(old.sections[0].items[0]).toEqual(whole("mail"));
    expect(forWire(old).sections[0].items[0]).toEqual(whole("mail"));
  });

  it("checks the keys as the API does", () => {
    const ok = starter([whole("mail", { rows: [`account:${A1}`], hidden: ["box:assigned"] })]);
    expect(spaceProblems(ok)).toEqual([]);
    const bad = starter([whole("mail", { hidden: ["nope"] })]);
    expect(spaceProblems(bad).map((p) => p.code)).toEqual(["bad_item"]);
    const many = starter([whole("teams", { rows: Array.from({ length: 301 }, (_, i) => `team:t${i}`) })]);
    expect(spaceProblems(many).map((p) => p.code)).toEqual(["too_many_arranged"]);
  });
});
