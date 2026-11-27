import { describe, expect, it } from "vitest";
import { procedureProblems } from "./procedures";

describe("procedureProblems", () => {
  it("checks the server's lengths", () => {
    expect(procedureProblems({ name: "Refunds", when: "A refund", instructions: "Steps" })).toEqual({});
    expect(procedureProblems({ name: " ", when: "ab", instructions: "x".repeat(8001) })).toEqual({ name: true, when: true, instructions: true });
  });
});
