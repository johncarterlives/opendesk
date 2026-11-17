import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n, loadAgentCatalogs } from "@/i18n";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { Workspace, WorkspaceSettings } from "@/lib/api/types";
import { qk } from "@/lib/queries";
import { snoozeAt } from "./snooze";
import { SnoozeMenu } from "./SnoozeMenu";

beforeAll(() => loadAgentCatalogs("fr"));

describe("SnoozeMenu", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.innerHTML = "";
    await i18n.changeLanguage("en");
    vi.unstubAllGlobals();
  });

  async function render(settings: WorkspaceSettings) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    qc.setQueryData<Workspace>(qk.workspace, { id: "w", name: "Acme", settings } as Workspace);
    const onSnooze = vi.fn<(at: Date) => void>();
    await act(async () =>
      root.render(
        <QueryClientProvider client={qc}>
          <TooltipProvider>
            <SnoozeMenu open onSnooze={onSnooze} />
          </TooltipProvider>
        </QueryClientProvider>,
      ),
    );
    const buttons = () => [...document.querySelectorAll<HTMLButtonElement>("button[type='button']")].filter((b) => b.querySelector(".mono") && !b.closest("form"));
    return { onSnooze, labels: () => buttons().map((b) => b.firstChild?.textContent), buttons };
  }

  it("offers today's four times while the workspace sets none", async () => {
    await i18n.changeLanguage("en");
    const { labels } = await render({});
    expect(labels()).toEqual(["In 1 hour", "In 4 hours", "Tomorrow", "Next week"]);
  });

  it("offers the workspace's times, with the date picker still there", async () => {
    await i18n.changeLanguage("fr");
    const presets = [
      { kind: "days", days: 1, time: "09:00" },
      { kind: "days", days: 3, time: "09:00" },
      { kind: "days", days: 7, time: "09:00" },
    ] as const;
    const { labels, buttons, onSnooze } = await render({ snooze_presets: [...presets] });
    expect(labels()).toEqual(["Demain", "Dans 3 jours", "Dans 7 jours"]);
    expect([...document.querySelectorAll("button[type='submit']")].map((b) => b.textContent)).toEqual(["Définir"]);
    await act(async () => buttons()[1].click());
    const want = snoozeAt(presets[1]);
    expect(onSnooze).toHaveBeenCalledTimes(1);
    expect(onSnooze.mock.calls[0][0].getTime()).toBe(want.getTime());
  });

  it("names hours and days in the reader's language", async () => {
    await i18n.changeLanguage("de");
    const { labels } = await render({ snooze_presets: [{ kind: "hours", hours: 2 }, { kind: "days", days: 2, time: "08:00" }, { kind: "week", time: "10:00" }] });
    expect(labels()).toEqual(["In 2 Stunden", "In 2 Tagen", "Nächste Woche"]);
  });

  describe("where Snooze is unavailable", () => {
    const reason = "Snooze works on shared accounts with Handling on.";

    async function renderUnavailable() {
      const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
      qc.setQueryData<Workspace>(qk.workspace, { id: "w", name: "Acme", settings: {} } as Workspace);
      const onSnooze = vi.fn<(at: Date) => void>();
      await act(async () =>
        root.render(
          <QueryClientProvider client={qc}>
            <TooltipProvider>
              <SnoozeMenu onSnooze={onSnooze} unavailable={reason} unavailableAction={<a href="/settings/x">Account settings</a>} />
              <p id="outside">Elsewhere</p>
            </TooltipProvider>
          </QueryClientProvider>,
        ),
      );
      const trigger = document.querySelector<HTMLButtonElement>("button[aria-disabled='true']");
      if (!trigger) throw new Error("Missing the greyed out Snooze button");
      const panel = () => document.querySelector("[role='dialog']");
      return { trigger, panel, onSnooze };
    }

    it("is a button that says it is disabled and why, for screen readers", async () => {
      await i18n.changeLanguage("en");
      const { trigger } = await renderUnavailable();
      expect(trigger.tagName).toBe("BUTTON");
      expect(trigger.disabled).toBe(false);
      expect(trigger.getAttribute("aria-label")).toBe(`Snooze: ${reason}`);
    });

    it("opens the reason and its link on a tap or click, never the choices", async () => {
      await i18n.changeLanguage("en");
      const { trigger, panel, onSnooze } = await renderUnavailable();
      expect(panel()).toBeNull();
      await act(async () => trigger.click());
      expect(panel()?.textContent).toContain(reason);
      expect(panel()?.querySelector("a")?.getAttribute("href")).toBe("/settings/x");
      expect(panel()?.querySelector("form")).toBeNull();
      expect(onSnooze).not.toHaveBeenCalled();
    });

    it("takes keyboard focus, and closes on Escape", async () => {
      await i18n.changeLanguage("en");
      const { trigger, panel } = await renderUnavailable();
      trigger.focus();
      expect(document.activeElement).toBe(trigger);
      // Enter and Space on a focused button are its click.
      await act(async () => trigger.click());
      expect(panel()).not.toBeNull();
      await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
      expect(panel()).toBeNull();
    });

    it("closes on a click away", async () => {
      await i18n.changeLanguage("en");
      const { trigger, panel } = await renderUnavailable();
      await act(async () => trigger.click());
      expect(panel()).not.toBeNull();
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0)); // the layer listens for outside presses from the next tick
        const outside = document.getElementById("outside")!;
        outside.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
        outside.click();
      });
      expect(panel()).toBeNull();
    });
  });
});
