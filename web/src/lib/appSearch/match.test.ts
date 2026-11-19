import { describe, expect, it } from "vitest";
import { parseQuery, prepare, rank, score, stem } from "./match";

const entries = [
  { id: "sidebar", fields: [{ text: "Customize sidebar", weight: 3 }, { text: "Arrange your sidebar: drag, rename, hide", weight: 1 }] },
  { id: "2fa", fields: [{ text: "Two-factor authentication", weight: 3 }, { text: "A code from an authenticator app", weight: 1 }] },
  { id: "labels", fields: [{ text: "Labels", weight: 3 }, { text: "Colour-coded tags for tickets", weight: 1 }] },
  { id: "timezone", fields: [{ text: "Time zone", weight: 3 }, { text: "Business hours and reports use it", weight: 1 }] },
  { id: "undo", fields: [{ text: "Undo send", weight: 3 }, { text: "Hold replies a few seconds before they go", weight: 1 }] },
  { id: "zh", fields: [{ text: "自定义侧边栏", weight: 3 }] },
].map((e) => ({ ...e, p: prepare(e.fields) }));

const find = (q: string, mode?: "all" | "most") => rank(entries, (e) => e.p, q, { mode }).map((e) => e.id);

describe("matching", () => {
  it("finds a word anywhere in a title, not just at its start", () => {
    expect(find("sidebar")[0]).toBe("sidebar");
    expect(find("authentication")[0]).toBe("2fa");
  });

  it("matches the start of a word being typed", () => {
    expect(find("custom side")[0]).toBe("sidebar");
    expect(find("authent")[0]).toBe("2fa");
  });

  it("forgives a typo or two", () => {
    expect(find("sidbar")[0]).toBe("sidebar");
    expect(find("custmize sidebar")[0]).toBe("sidebar");
    expect(find("authenticaton")[0]).toBe("2fa");
  });

  it("forgives no typo in a word under five letters", () => {
    expect(find("tame")).toEqual([]);
    expect(find("lables")[0]).toBe("labels");
  });

  it("matches stems", () => {
    expect(stem("labels")).toBe(stem("label"));
    expect(stem("archived")).toBe(stem("archive"));
    expect(stem("notes")).toBe(stem("note"));
    expect(find("label")[0]).toBe("labels");
  });

  it("knows everyday words for what the app calls something else", () => {
    expect(find("2fa")[0]).toBe("2fa");
    expect(find("tags")[0]).toBe("labels");
    expect(find("timezone")).toContain("timezone");
  });

  it("matches a piece of a longer word", () => {
    expect(find("bar")).toContain("sidebar");
  });

  it("needs every word of a search, and most words of a question", () => {
    expect(find("sidebar invoices")).toEqual([]);
    expect(find("how do I customize the sidebar on my phone", "most")[0]).toBe("sidebar");
    expect(find("how do I")).toEqual([]);
  });

  it("drops the words that only ask, and keeps weak words optional", () => {
    const q = parseQuery("how can I turn on undo send");
    expect(q.must.map((m) => m.w)).toEqual(["undo", "send"]);
    expect(q.may.map((m) => m.w)).toEqual(["turn"]);
    expect(find("turn on undo send")[0]).toBe("undo");
  });

  it("ranks a title that is the whole query first", () => {
    const a = prepare([{ text: "Labels", weight: 3 }]);
    const b = prepare([{ text: "Label colours", weight: 3 }]);
    expect(score(parseQuery("labels"), a)).toBeGreaterThan(score(parseQuery("labels"), b));
  });

  it("matches scripts without spaces as text", () => {
    expect(find("侧边栏")[0]).toBe("zh");
  });
});
