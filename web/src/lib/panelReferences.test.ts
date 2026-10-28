import { describe, expect, it } from "vitest";
import { DEFAULT_REFERENCE_PATTERN, findReferences, referenceRegExp } from "./panelReferences";

describe("ticket panel references", () => {
  it("finds what the server finds with the default pattern", () => {
    const re = referenceRegExp(DEFAULT_REFERENCE_PATTERN)!;
    expect(
      findReferences(
        re,
        "Order #1042 late, and SO-2026-0042?",
        "Hi, about S00042 and INV/2026/00012 (paid 129.00 EUR on 2026-10-02). PO4471 too. Call +32 470 12 34 56, 1000 Brussels. #1042 again. E27 GU10 LED3000K ISO 2026",
      ),
    ).toEqual(["#1042", "SO-2026-0042", "S00042", "INV/2026/00012", "PO4471"]);
  });

  it("sends a pattern's group, reads (?i), and refuses what would match everywhere", () => {
    expect(findReferences(referenceRegExp(String.raw`(?i)order (\d+)`)!, "order 5 ORDER 77 Order 77")).toEqual(["5", "77"]);
    expect(referenceRegExp("(unclosed")).toBeNull();
    expect(referenceRegExp(String.raw`\d*`)).toBeNull();
    expect(referenceRegExp("")).toBeNull();
    expect(findReferences(referenceRegExp(String.raw`#\d+`)!, Array.from({ length: 30 }, (_, i) => `#${i}`).join(" "))).toHaveLength(10);
  });
});
