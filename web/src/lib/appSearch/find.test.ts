import { describe, expect, it } from "vitest";
import { findHash, findTarget, parseFindHash } from "./find";

describe("find links", () => {
  it("round-trips a setting's label key through the URL hash", () => {
    const hash = findHash("auth:twofactorAuthentication");
    expect(hash).toBe("find=auth%3AtwofactorAuthentication");
    expect(parseFindHash(`#${hash}`)).toBe("auth:twofactorAuthentication");
    expect(parseFindHash("#tab=widgets")).toBeNull();
    expect(parseFindHash("#find=%E0%A4%A")).toBeNull();
    expect(parseFindHash("#find=" + encodeURIComponent("<img src=x>"))).toBeNull();
  });

  it("finds the section or row whose label reads the same, and highlights its whole block", () => {
    document.body.innerHTML = `
      <section data-find><h2 data-find-label>Password</h2></section>
      <section data-find>
        <h2 data-find-label>Two-factor authentication</h2>
        <div data-find id="row"><div data-find-label>Authenticator app</div></div>
      </section>`;
    expect(findTarget(document, "Authenticator app")?.target.id).toBe("row");
    expect(findTarget(document, "two-factor  Authentication")?.target.tagName).toBe("SECTION");
    expect(findTarget(document, "Passkeys")).toBeNull();
  });

  it("matches a label with a name filled in on the page", () => {
    document.body.innerHTML = `<div data-find id="peer"><label data-find-label>Let teammates' Ollie ask each other</label></div>`;
    expect(findTarget(document, "Let teammates' … ask each other")?.target.id).toBe("peer");
  });
});
