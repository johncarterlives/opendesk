import { afterEach, describe, expect, it, vi } from "vitest";
import type { View } from "@/lib/api/types";
import { cleanSection, clipSection, groupViews, matchSection, orderViews, readFolded, sectionProblem, viewSections, writeFolded } from "./viewSections";

const view = (name: string, position: number, section?: string | null): View => ({ id: name, name, shared: true, filters: {}, position, section });
const names = (vs: View[]) => vs.map((v) => v.name);

describe("groupViews", () => {
  it("keeps a flat list as it was, by position", () => {
    const entries = groupViews([view("b", 1), view("a", 0), view("c", 2, null)]);
    expect(entries.map((e) => (e.kind === "view" ? e.view.name : e.name))).toEqual(["a", "b", "c"]);
  });

  it("puts a section at its first view's place and its views by position inside", () => {
    const entries = groupViews([
      view("Urgent", 0),
      view("Return & refund", 3, "After sales"),
      view("Damaged & claims", 1, "After sales"),
      view("Bugs", 2, "Escalations"),
      view("Mine", 4),
      view("Delivery time", 5, "After sales"),
    ]);
    expect(entries.map((e) => (e.kind === "view" ? e.view.name : `[${e.name}] ${names(e.views).join(", ")}`))).toEqual([
      "Urgent",
      "[After sales] Damaged & claims, Return & refund, Delivery time",
      "[Escalations] Bugs",
      "Mine",
    ]);
  });

  it("matches sections in any case and spacing, spelled as the first view spells them", () => {
    const entries = groupViews([view("x", 2, "after  SALES"), view("y", 1, " After sales "), view("z", 3, "   ")]);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ kind: "section", key: "after sales", name: "After sales" });
    expect(entries[0].kind === "section" && names(entries[0].views)).toEqual(["y", "x"]);
    expect(entries[1]).toMatchObject({ kind: "view", view: { name: "z" } });
  });

  it("keeps the order views came in when positions tie", () => {
    expect(names(orderViews([view("b", 0, "S"), view("a", 0), view("c", 0, "S")]))).toEqual(["b", "c", "a"]);
  });
});

describe("orderViews and viewSections", () => {
  const list = [view("a", 0, "Two"), view("b", 1), view("c", 2, "One"), view("d", 3, "Two")];
  it("unfolds the sections in sidebar order", () => {
    expect(names(orderViews(list))).toEqual(["a", "d", "b", "c"]);
  });
  it("lists each section once, in sidebar order", () => {
    expect(viewSections(list)).toEqual(["Two", "One"]);
  });
});

describe("section names", () => {
  it("collapses spaces, and blank is none", () => {
    expect(cleanSection("  After \t sales ")).toBe("After sales");
    expect(cleanSection("   ")).toBe("");
    expect(cleanSection(null)).toBe("");
  });
  it("cuts at 60 characters as the API counts them", () => {
    expect(clipSection(" a ".repeat(40))).toHaveLength(59);
    expect([...clipSection("😀".repeat(70))]).toHaveLength(60);
  });
  it("refuses what the API refuses: angle brackets and control characters", () => {
    expect(sectionProblem("<b>x</b>")).toBe(true);
    expect(sectionProblem("a\u0007b")).toBe(true);
    expect(sectionProblem("After\tsales\n")).toBe(false);
    expect(sectionProblem("Billing & plans")).toBe(false);
  });
  it("joins the section a typed name names in any case", () => {
    expect(matchSection("after SALES ", ["Escalations", "After sales"])).toBe("After sales");
    expect(matchSection(" Delivery  time", ["After sales"])).toBe("Delivery time");
  });
});

describe("folded sections", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("are kept per workspace and member", () => {
    writeFolded("w1", "u1", new Set(["after sales"]));
    expect([...readFolded("w1", "u1")]).toEqual(["after sales"]);
    expect(readFolded("w2", "u1").size).toBe(0);
    expect(readFolded("w1", "u2").size).toBe(0);
    writeFolded("w1", "u1", new Set());
    expect(readFolded("w1", "u1").size).toBe(0);
  });

  it("read as none when storage fails or holds something else", () => {
    localStorage.setItem("od-nav-view-sections:w1:u1", "{oops");
    expect(readFolded("w1", "u1").size).toBe(0);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(readFolded("w1", "u1").size).toBe(0);
    expect(() => writeFolded("w1", "u1", new Set(["x"]))).not.toThrow();
  });
});
