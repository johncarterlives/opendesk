import "@/i18n";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Command } from "cmdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppHit } from "@/lib/appSearch";
import { ticket } from "@/lib/test/fixtures";
import { AiResults } from "./PaletteAiResults";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => {};
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const sidebar: AppHit = { kind: "feature", id: "f:customize-sidebar", title: "Customize sidebar", where: ["Sidebar"], action: "customizeSidebar", text: "" };
const twoFactor: AppHit = {
  kind: "setting",
  id: "s:2fa",
  title: "Two-factor authentication",
  where: ["Settings", "Security"],
  route: "/settings/security",
  hash: "find=auth%3AtwofactorAuthentication",
  entry: { r: "/settings/security", k: "s", t: "auth:twofactorAuthentication" },
  text: "",
};
const guide: AppHit = { kind: "doc", id: "d:sidebar", title: "Edit your sidebar", where: ["Docs", "Your sidebar"], href: "https://docs.opendesk.sh/guides/sidebar/#edit-your-sidebar", text: "" };

type Props = Partial<Parameters<typeof AiResults>[0]>;

async function render(p: Props = {}) {
  const props: Parameters<typeof AiResults>[0] = {
    query: "custom sidebar",
    pending: false,
    data: { tickets: [], contacts: [], articles: [], wiki_pages: [] } as never,
    error: false,
    ticket: () => ({ href: "/t", onSelect: () => {} }),
    contact: (id) => ({ href: `/contacts/${id}`, onSelect: () => {} }),
    article: () => ({ href: "/a", onSelect: () => {} }),
    onExample: () => {},
    places: [],
    docs: [],
    hitLink: (h) => ({ href: h.kind === "setting" ? `${h.route}#${h.hash}` : h.kind === "doc" ? h.href : undefined, onSelect: () => {} }),
    assistant: "Ollie",
    answer: null,
    onAnswer: () => {},
    ...p,
  };
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <Command shouldFilter={false}>
          <Command.List>
            <AiResults {...props} />
          </Command.List>
        </Command>
      </QueryClientProvider>,
    ),
  );
}

const text = () => host.textContent ?? "";

describe("Ask AI results", () => {
  it("says nothing is related only when the app, its docs and the workspace have nothing", async () => {
    await render();
    expect(text()).toContain("Nothing related yet");
  });

  it("lists places in the app and docs sections that answer a question about opendesk", async () => {
    await render({ places: [sidebar, twoFactor], docs: [guide] });
    expect(text()).not.toContain("Nothing related yet");
    expect(text()).toContain("In the app");
    expect(text()).toContain("Customize sidebar");
    expect(text()).toContain("From the docs");
    const links = [...host.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(links).toEqual(["/settings/security#find=auth%3AtwofactorAuthentication", "https://docs.opendesk.sh/guides/sidebar/#edit-your-sidebar"]);
    // The feature runs in place: an option, not a link.
    expect([...host.querySelectorAll("[cmdk-item]")].some((el) => el.tagName !== "A" && el.textContent?.includes("Customize sidebar"))).toBe(true);
  });

  it("offers Ollie's answer from them, and shows it once asked", async () => {
    const onAnswer = vi.fn();
    await render({ places: [sidebar], onAnswer });
    const ask = [...host.querySelectorAll<HTMLElement>("[cmdk-item]")].find((el) => el.textContent?.includes("Answer with Ollie"))!;
    await act(async () => ask.click());
    expect(onAnswer).toHaveBeenCalledOnce();

    await render({ places: [sidebar], answer: { pending: true, error: false } });
    expect(text()).toContain("Ollie is reading the docs");
    expect(text()).not.toContain("Answer with Ollie");

    await render({ places: [sidebar], answer: { pending: false, error: false, text: "Click Customize at the bottom of the sidebar." } });
    expect(text()).toContain("Click Customize at the bottom of the sidebar.");

    await render({ places: [sidebar], answer: { pending: false, error: true } });
    expect(text()).toContain("Couldn't answer right now");
  });

  it("lists the contacts it found, linked to their pages, and marks a follow-up ticket", async () => {
    const buyer = { id: "c1", name: "Bea Buyer", email: "buyer@example.com", avatar_url: null, company: null };
    await render({
      query: "buyer@example.com",
      data: { tickets: [ticket({ id: "t2", number: 7, subject: "Where is my order", custom: { previous_ticket_id: "t1" } })], contacts: [buyer], articles: [] } as never,
    });
    expect(text()).not.toContain("Nothing related yet");
    expect(text()).toContain("Contacts");
    expect(text()).toContain("Bea Buyer");
    expect(host.querySelector('a[href="/contacts/c1"]')?.textContent).toContain("buyer@example.com");
    expect(host.querySelector("[data-follow-up]")?.closest("[cmdk-item]")?.textContent).toContain("Where is my order");
  });

  it("offers no answer when there is nothing to answer from", async () => {
    await render({ data: { tickets: [], contacts: [], articles: [{ id: "a1", title: "Refunds", status: "published" }], wiki_pages: [] } as never });
    expect(text()).not.toContain("Answer with Ollie");
  });
});
