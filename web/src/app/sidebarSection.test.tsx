import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { i18n } from "@/i18n";
import { useSession } from "@/lib/session";
import { Section } from "./sidebarParts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  await i18n.changeLanguage("en");
  localStorage.clear();
  useSession.setState({ workspaceId: "w1", user: { id: "u1" } as never });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("a sidebar section's title", () => {
  it("folds and unfolds on every click, a double click included, and never opens a rename", async () => {
    const edit = { key: "section:own-1", placeholder: "Section", renameLabel: "Rename Clients", onName: () => {}, menu: null };
    await act(async () =>
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <Section id="own-1" label="Clients" rail={false} edit={edit}>
            <a href="/x">Row</a>
          </Section>
        </QueryClientProvider>,
      ),
    );
    const title = () => host.querySelector<HTMLButtonElement>("button[aria-expanded]");
    expect(title()!.getAttribute("aria-expanded")).toBe("true");
    // A double click as the browser sends it: two clicks, then dblclick.
    await act(async () => void title()!.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })));
    await act(async () => void title()!.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 2 })));
    await act(async () => void title()!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, detail: 2 })));
    expect(host.querySelector("input")).toBeNull();
    expect(title()!.getAttribute("aria-expanded")).toBe("true");
    await act(async () => title()!.click());
    expect(title()!.getAttribute("aria-expanded")).toBe("false");
  });
});
