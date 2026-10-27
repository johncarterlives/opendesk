import { describe, expect, it } from "vitest";
import { addCategory, cleanCategory, entryState, fromLocalParts, localParts, MAX_CATEGORIES } from "./changelog";

describe("entryState", () => {
  const now = Date.parse("2026-10-27T12:00:00Z");
  it("reads drafts as drafts whatever their date", () => {
    expect(entryState({ status: "draft", published_at: null }, now)).toBe("draft");
    expect(entryState({ status: "draft", published_at: "2027-01-01T00:00:00Z" }, now)).toBe("draft");
  });
  it("schedules a published entry dated later", () => {
    expect(entryState({ status: "published", published_at: "2026-10-27T12:00:01Z" }, now)).toBe("scheduled");
  });
  it("shows a published entry dated now or earlier", () => {
    expect(entryState({ status: "published", published_at: "2026-10-27T12:00:00Z" }, now)).toBe("published");
    expect(entryState({ status: "published", published_at: "2025-01-01T00:00:00Z" }, now)).toBe("published");
    expect(entryState({ status: "published", published_at: null }, now)).toBe("published");
  });
});

describe("categories", () => {
  it("collapses whitespace", () => {
    expect(cleanCategory("  New   feature ")).toBe("New feature");
    expect(cleanCategory("   ")).toBeNull();
  });
  it("adds a new name and refuses another spelling of one already there", () => {
    expect(addCategory(["New"], " Fixed ")).toEqual({ list: ["New", "Fixed"] });
    expect(addCategory(["New"], "new")).toEqual({ problem: "duplicate" });
    expect(addCategory(["New"], "NEW ")).toEqual({ problem: "duplicate" });
  });
  it("holds names to 32 characters and lists to five", () => {
    expect(addCategory([], "x".repeat(32))).toEqual({ list: ["x".repeat(32)] });
    expect(addCategory([], "x".repeat(33))).toEqual({ problem: "tooLong" });
    const five = ["a", "b", "c", "d", "e"];
    expect(five).toHaveLength(MAX_CATEGORIES);
    expect(addCategory(five, "f")).toEqual({ problem: "full" });
    expect(addCategory([], " ")).toEqual({ problem: "empty" });
  });
});

describe("local date parts", () => {
  it("round-trips an instant through the reader's day and time", () => {
    const iso = fromLocalParts("2026-11-03", "09:30")!;
    expect(localParts(iso)).toEqual({ day: "2026-11-03", time: "09:30" });
  });
  it("starts a day without a time at midnight, and has no instant without a day", () => {
    expect(localParts(fromLocalParts("2026-11-03", ""))).toEqual({ day: "2026-11-03", time: "00:00" });
    expect(fromLocalParts("", "09:30")).toBeNull();
    expect(localParts(null)).toEqual({ day: "", time: "" });
  });
});
