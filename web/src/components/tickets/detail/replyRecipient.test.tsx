import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import type { Message } from "@/lib/api/types";
import { EmailChips } from "./composerParts";
import { replyRecipient } from "./replyRecipient";

const inbound = (from: string, extra: Partial<Message> = {}) =>
  ({ direction: "inbound", kind: "reply", from_email: from, reply_to: "", reply_address: "", auth_failed: false, ...extra }) as Message;

describe("replyRecipient", () => {
  it("uses the reply address of the customer's latest email", () => {
    const msgs = [inbound("alerts@updates.acme.test", { reply_to: "jane@acme.test", reply_address: "jane@acme.test" })];
    expect(replyRecipient("alerts@updates.acme.test", msgs)).toBe("jane@acme.test");
  });

  it("keeps the customer's address otherwise", () => {
    expect(replyRecipient("ceo@acme.test", [inbound("ceo@acme.test", { reply_to: "pay@evil.test" })])).toBe("ceo@acme.test");
    expect(replyRecipient("ceo@acme.test", [inbound("someone@else.test", { reply_address: "x@else.test" })])).toBe("ceo@acme.test");
    expect(replyRecipient("ceo@acme.test", [inbound("ceo@acme.test", { reply_address: "a@acme.test", auth_failed: true })])).toBe("ceo@acme.test");
    expect(replyRecipient("ceo@acme.test", undefined)).toBe("ceo@acme.test");
  });
});

describe("EmailChips suggestions", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    await i18n.changeLanguage("en");
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  it("offers addresses not in the list and adds one on click", async () => {
    const onChange = vi.fn();
    await act(async () =>
      root.render(<EmailChips label="To" values={["jane@acme.test"]} onChange={onChange} suggestions={["JANE@acme.test", "alerts@updates.acme.test"]} />),
    );
    const offered = [...host.querySelectorAll("button")].filter((b) => b.getAttribute("aria-label")?.startsWith("Add "));
    expect(offered.map((b) => b.textContent)).toEqual(["alerts@updates.acme.test"]);
    await act(async () => offered[0].click());
    expect(onChange).toHaveBeenCalledWith(["jane@acme.test", "alerts@updates.acme.test"]);
  });
});
