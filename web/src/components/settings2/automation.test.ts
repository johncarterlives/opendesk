import { describe, expect, it } from "vitest";
import { actionLabel, actionNeedsValue, aiActions, fieldLabel, isPhraseOp, offered, opLabel, opsFor, phrases, sentimentLabel, triggerLabel, validPhrases } from "./automation";

describe("automation AI helpers", () => {
  it("offers AI actions only when AI is on, but keeps one in use", () => {
    const keys = ["add_tag", "ai_triage"] as const;
    expect(offered([...keys], aiActions, false)).toEqual(["add_tag"]);
    expect(offered([...keys], aiActions, true)).toEqual(["add_tag", "ai_triage"]);
    expect(offered([...keys], aiActions, false, "ai_triage")).toEqual(["add_tag", "ai_triage"]);
  });

  it("offers is / is not for sentiment and needs no value for triage", () => {
    expect(opsFor("sentiment")).toEqual(["equals", "not_equals"]);
    expect(actionNeedsValue("ai_triage")).toBe(false);
    expect(actionNeedsValue("set_field")).toBe(false);
    expect(actionNeedsValue("delete_ticket")).toBe(false);
    expect(sentimentLabel("frustrated")).toBe("Frustrated");
    expect(sentimentLabel("custom")).toBe("custom");
  });
});

describe("automation labels", () => {
  it("reads every label from the catalogs", () => {
    expect(triggerLabel.ticket_created).toBe("A ticket is created");
    expect(opLabel.not_contains).toBe("doesn't contain");
    expect(actionLabel.add_tag).toBe("Add label");
    expect(actionLabel.remove_tag).toBe("Remove label");
    expect(fieldLabel.tag).toBe("Label");
    expect(fieldLabel.from_email).toBe("Sender email");
    expect(Object.keys(fieldLabel)).toContain("sentiment");
    expect(Object.keys(actionLabel).at(-1)).toBe("ai_triage");
    expect(actionLabel.set_field).toBe("Set field");
    expect(actionLabel.delete_ticket).toBe("Delete ticket");
    expect(opLabel.any).toBe("contains any of");
    expect(opLabel.none).toBe("contains none of");
  });
});

describe("phrase lists", () => {
  it("offers contains any of and none of on text fields and the address written to only", () => {
    for (const f of ["subject", "body", "from_email", "received_at"] as const) expect(opsFor(f)).toEqual(expect.arrayContaining(["any", "none"]));
    for (const f of ["status", "channel", "tag", "sentiment", "ai_decide"] as const) expect(opsFor(f)).not.toContain("any");
    expect(isPhraseOp("none")).toBe(true);
    expect(isPhraseOp("not_contains")).toBe(false);
  });

  it("reads one phrase per line, trimmed, without empty lines", () => {
    expect(phrases("  Your order has shipped \r\n\n\tnewsletter  \n   \ninvoice ")).toEqual(["Your order has shipped", "newsletter", "invoice"]);
    expect(phrases(" \n ")).toEqual([]);
  });

  it("takes 1 to 100 phrases of up to 500 characters, 5000 in all", () => {
    expect(validPhrases("refund")).toBe(true);
    expect(validPhrases(" \n \n ")).toBe(false);
    expect(validPhrases(Array.from({ length: 100 }, (_, i) => `p${i}`).join("\n"))).toBe(true);
    expect(validPhrases(Array.from({ length: 101 }, (_, i) => `p${i}`).join("\n"))).toBe(false);
    expect(validPhrases("x".repeat(500))).toBe(true);
    expect(validPhrases("x".repeat(501))).toBe(false);
    expect(validPhrases(Array.from({ length: 11 }, () => "x".repeat(500)).join("\n"))).toBe(false);
  });
});
