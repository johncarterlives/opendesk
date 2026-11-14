import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installMock } from "../index";
import { dispatch } from "../router";
import { db } from "../db";

async function call(path: string, body: unknown) {
  const request = dispatch(`http://mock${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "OD-Workspace": db.workspaces[0].workspace.id },
  });
  await vi.advanceTimersByTimeAsync(900);
  const response = await request;
  return { status: response.status, body: await response.json() };
}

const credentials = { url: "https://support.example.com/help/freescout/", api_key: "secret-key" };

describe("FreeScout imports (mock)", () => {
  installMock();
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it.each(["url", "api_key"])("reports the missing %s credential on its field", async (field) => {
    const result = await call("/v1/imports/check", { source: "freescout", credentials: { ...credentials, [field]: " " } });
    expect(result.status).toBe(422);
    expect(result.body.errors).toContainEqual({ location: `body.credentials.${field}`, message: "Required" });
  });

  it.each(["not a URL", "http://support.example.com", "https://user:secret@support.example.com", "https://support.example.com?api_key=secret", "https://support.example.com/#secret"])("refuses an invalid instance URL: %s", async (url) => {
    const result = await call("/v1/imports/check", { source: "freescout", credentials: { ...credentials, url } });
    expect(result.status).toBe(422);
    expect(result.body.errors[0].location).toBe("body.credentials.url");
    expect(JSON.stringify(result.body)).not.toContain(url);
  });

  it("checks a subdirectory installation and previews conversations, notes and files without articles", async () => {
    const result = await call("/v1/imports/check", { source: "freescout", credentials });
    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({
      account: { name: "support.example.com", url: "https://support.example.com/help/freescout" },
      has_articles: false,
      totals: { tickets: 1284, articles: null },
    });
    expect(result.body.agents.length).toBeGreaterThan(0);
    expect(result.body.groups.length).toBeGreaterThan(0);
    expect(result.body.samples[0].messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ agent: false, note: false, attachments: 1 }),
      expect.objectContaining({ agent: true, note: true }),
      expect.objectContaining({ agent: true, note: false }),
    ]));
    expect(JSON.stringify(result.body)).not.toContain(credentials.api_key);
  });

  it("refuses a rejected key without exposing it", async () => {
    const result = await call("/v1/imports/check", { source: "freescout", credentials: { ...credentials, api_key: "bad-private-key" } });
    expect(result.status).toBe(422);
    expect(result.body.code).toBe("import_auth_failed");
    expect(result.body.detail).toContain("FreeScout");
    expect(JSON.stringify(result.body)).not.toContain("bad-private-key");
  });

  it("starts and completes a ticket-only import even when articles are requested", async () => {
    const result = await call("/v1/imports", { source: "freescout", credentials });
    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({ source: "freescout", phase: "tickets", options: { articles: false }, totals: { articles: null } });
    await vi.advanceTimersByTimeAsync(30_000);
    const response = await dispatch(`http://mock/v1/imports/${result.body.id}`, { headers: { "OD-Workspace": db.workspaces[0].workspace.id } });
    expect(await response.json()).toMatchObject({ status: "completed", phase: "done", counts: { tickets: 1284, articles: 0 } });
  });
});
