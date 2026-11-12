import { describe, expect, it } from "vitest";
import type { KbArticle, KbCollection } from "@/lib/api/types";
import { installMock } from "../index";
import { dispatch } from "../router";
import { db } from "../db";

async function call(method: string, path: string, body?: unknown) {
  const ws = db.workspaces[0]?.workspace.id;
  const r = await dispatch(`http://mock${path}`, { method, body: body ? JSON.stringify(body) : undefined, headers: ws ? { "OD-Workspace": ws } : {} });
  return { status: r.status, body: r.status === 204 ? null : await r.json() };
}

describe("mock knowledge base addresses", () => {
  installMock();

  it("places articles in their collection, with slugs unique per collection", async () => {
    const [first] = db.workspaces[0].articles;
    const col = db.workspaces[0].collections.find((c) => c.id === first.collection_id)!;
    expect(first.path).toBe(`/c/${col.slug}/${first.slug}`);

    const other = (await call("POST", "/v1/kb/collections", { name: "Elsewhere" })).body as KbCollection;
    const twin = (await call("POST", "/v1/kb/articles", { title: "Twin", slug: first.slug, collection_id: other.id })).body as KbArticle;
    expect(twin.slug).toBe(first.slug);
    expect(twin.path).toBe(`/c/${other.slug}/${first.slug}`);

    // Moving into a collection where the slug is taken needs a new slug.
    expect((await call("PATCH", `/v1/kb/articles/${twin.id}`, { collection_id: col.id })).status).toBe(409);
    const moved = (await call("PATCH", `/v1/kb/articles/${twin.id}`, { collection_id: col.id, slug: "twin-moved" })).body as KbArticle;
    expect(moved.path).toBe(`/c/${col.slug}/twin-moved`);

    // A renamed collection moves its articles' paths with it.
    await call("PATCH", `/v1/kb/collections/${other.id}`, { slug: "elsewhere-now" });
    const loose = (await call("POST", "/v1/kb/articles", { title: "Loose", collection_id: other.id })).body as KbArticle;
    expect(loose.path).toBe("/c/elsewhere-now/loose");
    // Deleting it leaves the article outside any collection, at /a/.
    await call("DELETE", `/v1/kb/collections/${other.id}`);
    expect(((await call("GET", `/v1/kb/articles/${loose.id}`)).body as KbArticle).path).toBe("/a/loose");
  });
});
