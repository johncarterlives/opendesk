import type { QueryClient } from "@tanstack/react-query";
import { isRedirect } from "@tanstack/react-router";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./api/client";
import { folderById } from "./folders";
import { ticketFolder, viewOrTicket } from "./viewLink";

async function thrown(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("did not throw");
}

/** A query client whose ticket query answers `ticket`, or fails with it when it is an Error. */
function qcWith(ticket: unknown): QueryClient {
  return { ensureQueryData: vi.fn(() => (ticket instanceof Error ? Promise.reject(ticket) : Promise.resolve(ticket))) } as unknown as QueryClient;
}

const viewNotFound = () => new ApiError({ title: "Unprocessable Entity", status: 422, detail: "view not found" });

describe("view links", () => {
  it("maps every status to an inbox folder that exists", () => {
    const cases = [["open", "open"], ["pending", "pending"], ["on_hold", "pending"], ["solved", "solved"], ["closed", "solved"]] as const;
    for (const [status, folder] of cases) {
      expect(ticketFolder({ status, spam: false })).toBe(folder);
      expect(folderById(folder)).toBeDefined();
    }
    expect(ticketFolder({ status: "open", spam: true })).toBe("spam");
  });

  it("opens the ticket in its folder when the view can't be loaded (another member's personal view)", async () => {
    const qc = qcWith({ id: "t-1", status: "pending", spam: false });
    const e = await thrown(viewOrTicket(qc, "t-1", () => Promise.reject(viewNotFound())));
    expect(isRedirect(e)).toBe(true);
    const opts = (e as { options: Record<string, unknown> }).options;
    expect(opts.to).toBe("/inbox/$folder/{-$ticketId}");
    expect(opts.params).toEqual({ folder: "pending", ticketId: "t-1" });
    expect(opts.replace).toBe(true);
    // A 404 too.
    const gone = new ApiError({ title: "Not Found", status: 404 });
    expect(isRedirect(await thrown(viewOrTicket(qc, "t-1", () => Promise.reject(gone))))).toBe(true);
  });

  it("keeps the view's error without a ticket in the link, for a ticket the reader can't read, and for other failures", async () => {
    const err = viewNotFound();
    expect(await thrown(viewOrTicket(qcWith({ id: "t", status: "open", spam: false }), undefined, () => Promise.reject(err)))).toBe(err);
    expect(await thrown(viewOrTicket(qcWith(new ApiError({ title: "Not Found", status: 404 })), "t", () => Promise.reject(err)))).toBe(err);
    const boom = new ApiError({ title: "Internal", status: 500, detail: "" });
    expect(await thrown(viewOrTicket(qcWith({ id: "t", status: "open", spam: false }), "t", () => Promise.reject(boom)))).toBe(boom);
    const invalid = new ApiError({ title: "Unprocessable Entity", status: 422, detail: "invalid status" });
    expect(await thrown(viewOrTicket(qcWith({ id: "t", status: "open", spam: false }), "t", () => Promise.reject(invalid)))).toBe(invalid);
  });

  it("returns the view's list when it loads", async () => {
    const qc = qcWith(null);
    expect(await viewOrTicket(qc, "t", () => Promise.resolve("list"))).toBe("list");
    expect(qc.ensureQueryData).not.toHaveBeenCalled();
  });
});
