import { describe, expect, it } from "vitest";
import type { ImapFolders, Mailbox } from "@/lib/api/types";
import { defaultSentFolder } from "@/components/mailboxes/ImapFolders";
import { installMock } from "../index";
import { dispatch } from "../router";
import { db } from "../db";

async function call(method: string, path: string, body?: unknown) {
  const ws = db.workspaces[0]?.workspace.id;
  const r = await dispatch(`http://mock${path}`, { method, body: body ? JSON.stringify(body) : undefined, headers: ws ? { "OD-Workspace": ws } : {} });
  return { status: r.status, body: r.status === 204 ? null : await r.json() };
}

describe("mock IMAP folders", () => {
  installMock();
  const boxes = async () => (await call("GET", "/v1/mailboxes")).body.data as Mailbox[];

  it("lists the server's folders and the ones the mailbox reads", async () => {
    const partners = (await boxes()).find((m) => m.inbound_kind === "imap")!;
    const r = await call("GET", `/v1/mailboxes/${partners.id}/imap-folders`);
    expect(r.status).toBe(200);
    const list = r.body as ImapFolders;
    expect(list.folders[0]).toMatchObject({ name: "INBOX", special: "inbox" });
    expect(list.selected).toEqual(["INBOX", "Support.Partners"]);
  });

  it("stores a tidy folder list and keeps its rules", async () => {
    const partners = (await boxes()).find((m) => m.inbound_kind === "imap")!;
    const url = `/v1/mailboxes/${partners.id}`;
    const ok = await call("PATCH", url, { imap_folders: [" Support.Billing ", "inbox", "INBOX", ""] });
    expect(ok.status).toBe(200);
    expect((ok.body as Mailbox).imap_folders).toEqual(["Support.Billing", "INBOX"]);
    const inboxOnly = await call("PATCH", url, { imap_folders: ["Inbox"] });
    expect((inboxOnly.body as Mailbox).imap_folders).toEqual([]);
    const eleven = Array.from({ length: 11 }, (_, i) => `F${i}`);
    for (const bad of [eleven, ["Bad\nName"], ["x".repeat(256)]]) {
      expect((await call("PATCH", url, { imap_folders: bad })).status).toBe(422);
    }
  });

  it("has no folders for a mailbox that does not read over IMAP", async () => {
    const fwd = (await boxes()).find((m) => m.inbound_kind === "forwarding")!;
    expect((await call("GET", `/v1/mailboxes/${fwd.id}/imap-folders`)).status).toBe(422);
    expect((await call("PATCH", `/v1/mailboxes/${fwd.id}`, { imap_folders: ["Archive"] })).status).toBe(422);
  });

  it("keeps sent email in a folder only where the mailbox reads over IMAP and sends itself", async () => {
    const partners = (await boxes()).find((m) => m.inbound_kind === "imap")!;
    const url = `/v1/mailboxes/${partners.id}`;
    const on = await call("PATCH", url, { imap_sent_folder: " Sent " });
    expect(on.status).toBe(200);
    expect((on.body as Mailbox).imap_sent_folder).toBe("Sent");
    for (const bad of ["inbox", "Sent\nBox", "x".repeat(256)]) expect((await call("PATCH", url, { imap_sent_folder: bad })).status).toBe(422);
    expect(((await call("PATCH", url, { imap_sent_folder: "" })).body as Mailbox).imap_sent_folder).toBe("");
    const fwd = (await boxes()).find((m) => m.inbound_kind === "forwarding")!;
    expect((await call("PATCH", `/v1/mailboxes/${fwd.id}`, { imap_sent_folder: "Sent" })).status).toBe(422);
  });

  it("picks the server's Sent folder by default", () => {
    expect(defaultSentFolder([{ name: "INBOX", path: "INBOX", special: "inbox" }, { name: "Sent Items", path: "Sent Items", special: "sent" }])).toBe("Sent Items");
    expect(defaultSentFolder([{ name: "INBOX.Sent", path: "INBOX/Sent", special: "" }])).toBe("INBOX.Sent");
    expect(defaultSentFolder([])).toBe("Sent");
  });
});
