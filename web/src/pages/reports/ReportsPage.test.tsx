// A member who is not an admin gets their own row alone in the overview's by_agent; the page
// shows their own first response rather than a ranking of one.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { i18n } from "@/i18n";
import type { ReportsOverview } from "@/lib/api/types";
import { ResponseCard } from "./ReportsPage";

const agent = (id: string, name: string, first: number | null) => ({
  user: { id, name, email: `${id}@example.com`, avatar_url: null },
  solved: 3,
  first_response_p50_minutes: first,
});

const overview = (by_agent: ReportsOverview["by_agent"]) =>
  ({ first_response_p50_minutes: 75, resolution_p50_minutes: 120, by_agent }) as unknown as ReportsOverview;

let host: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  await i18n.changeLanguage("en");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("ResponseCard", () => {
  it("ranks every member for an admin", () => {
    act(() => root.render(<ResponseCard d={overview([agent("bea", "Bea", 40), agent("anna", "Anna", 20)])} />));
    expect(host.textContent).toContain("Fastest first reply");
    const names = [...host.querySelectorAll("li")].map((li) => li.textContent);
    expect(names).toHaveLength(2);
    expect(names[0]).toContain("Anna");
    expect(names[1]).toContain("Bea");
  });

  it("shows a member their own first response, no ranking", () => {
    act(() => root.render(<ResponseCard d={overview([agent("anna", "Anna", 20)])} own me="anna" />));
    expect(host.textContent).not.toContain("Fastest first reply");
    expect(host.querySelectorAll("li")).toHaveLength(0);
    expect(host.textContent).toContain("Your first response");
    expect(host.textContent).toContain("20m");
    // The team's medians stay.
    expect(host.textContent).toContain("1h 15m");
  });

  it("shows a dash, not someone else's figure, when the member has no row", () => {
    act(() => root.render(<ResponseCard d={overview([agent("bea", "Bea", 40)])} own me="anna" />));
    expect(host.textContent).toContain("Your first response");
    expect(host.textContent).not.toContain("40m");
    expect(host.textContent).not.toContain("Bea");
  });
});
