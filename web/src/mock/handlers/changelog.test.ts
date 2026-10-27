import { describe, expect, it } from "vitest";
import { installMock } from "../index";
import { dispatch } from "../router";
import { db } from "../db";
import type { ChangelogEntry } from "@/lib/api/types";

async function call(method: string, path: string, body?: unknown) {
  const ws = db.workspaces[0]?.workspace.id;
  const r = await dispatch(`http://mock${path}`, {
    method,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    headers: ws ? { "OD-Workspace": ws } : {},
  });
  return { status: r.status, body: r.status === 204 ? null : await r.json() };
}
const list = async (query = ""): Promise<ChangelogEntry[]> => (await call("GET", `/v1/changelog/entries${query}`)).body.data;

describe("mock changelog", () => {
  installMock();

  it("lists live, scheduled and draft entries apart, newest first", async () => {
    const live = await list("?status=published");
    expect(live.length).toBeGreaterThan(1);
    expect(live.every((e) => e.status === "published" && Date.parse(e.published_at!) <= Date.now())).toBe(true);
    expect(live.map((e) => e.published_at)).toEqual([...live.map((e) => e.published_at)].sort().reverse());
    const scheduled = await list("?status=scheduled");
    expect(scheduled.map((e) => e.title)).toEqual(["Offline mode for iOS and Android"]);
    expect((await list("?status=draft")).every((e) => e.status === "draft")).toBe(true);
  });

  it("filters by category without case and counts the categories in use", async () => {
    expect((await list("?category=fixed")).map((e) => e.title)).toEqual(["PDF export keeps your page breaks"]);
    const cats = (await call("GET", "/v1/changelog/categories")).body as { name: string; count: number }[];
    expect(cats[0]).toEqual({ name: "New", count: 4 });
  });

  it("dates an entry when first published, keeps the date when unpublished, and drops a second spelling of a category", async () => {
    const draft = (await call("POST", "/v1/changelog/entries", { title: "Dark mode", categories: ["New", " new ", "Improved"] })).body as ChangelogEntry;
    expect(draft).toMatchObject({ status: "draft", published_at: null, slug: "dark-mode", categories: ["New", "Improved"] });
    const live = (await call("PATCH", `/v1/changelog/entries/${draft.id}`, { status: "published" })).body as ChangelogEntry;
    expect(live.published_at).not.toBeNull();
    const back = (await call("PATCH", `/v1/changelog/entries/${draft.id}`, { status: "draft" })).body as ChangelogEntry;
    expect(back.published_at).toBe(live.published_at);
    expect((await call("POST", "/v1/changelog/entries", { title: "Other", slug: "dark-mode" })).status).toBe(409);
    expect((await call("POST", "/v1/changelog/entries", { title: "Many", categories: ["a", "b", "c", "d", "e", "f"] })).status).toBe(422);
    expect((await call("DELETE", `/v1/changelog/entries/${draft.id}`)).status).toBe(204);
    expect((await call("GET", `/v1/changelog/entries/${draft.id}`)).status).toBe(404);
  });
});
