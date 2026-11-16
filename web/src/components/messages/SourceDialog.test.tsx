import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/i18n";
import { i18n } from "@/i18n";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ApiError } from "@/lib/api/client";
import type { MailSource } from "@/lib/api/types";
import { SourceDialog, splitSource } from "./SourceDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  await i18n.changeLanguage("en");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

const raw = "Received: from mx\r\nFrom: Ada <ada@example.com>\r\nSubject: Hi\r\n\r\nHello there\r\n";
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

async function show(load: () => Promise<MailSource>, file = vi.fn()) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider>
          <SourceDialog open onOpenChange={() => {}} title="Hi" queryKey={["t", Math.random()]} load={load} file={file} />
        </TooltipProvider>
      </QueryClientProvider>,
    ),
  );
  await flush();
  return file;
}

describe("message source", () => {
  it("splits the headers from the body at the first empty line", () => {
    expect(splitSource(raw)).toEqual({ headers: "Received: from mx\r\nFrom: Ada <ada@example.com>\r\nSubject: Hi", body: "Hello there\r\n" });
    expect(splitSource("Subject: only headers")).toEqual({ headers: "Subject: only headers", body: "" });
    expect(splitSource("A: 1\n\nbody")).toEqual({ headers: "A: 1", body: "body" });
  });

  it("shows the raw message, with its headers and body as the server delivered them", async () => {
    await show(() => Promise.resolve({ source: raw, size_bytes: raw.length, truncated: false }));
    const text = document.querySelector('[data-testid="message-source"]')?.textContent ?? "";
    expect(text).toContain("Received: from mx");
    expect(text).toContain("Subject: Hi");
    expect(text).toContain("Hello there");
    expect(document.body.textContent).toContain("Original message");
    expect(document.body.textContent).not.toContain("Only the first part");
  });

  it("says when only the start of a large message is shown", async () => {
    await show(() => Promise.resolve({ source: raw, size_bytes: 3 * 1024 * 1024, truncated: true }));
    expect(document.body.textContent).toContain("The download has the whole message (3072 KB)");
  });

  it("says plainly when a message has no source", async () => {
    await show(() => Promise.reject(new ApiError({ status: 404, code: "not_found", detail: "Message source not found" })));
    expect(document.body.textContent).toContain("isn't available");
    expect(document.querySelector('[data-testid="message-source"]')).toBeNull();
  });

  it("passes on the server's reason when the source could not be read", async () => {
    const detail = "The message could not be read from the mail provider. Try again.";
    await show(() => Promise.reject(new ApiError({ status: 502, code: "provider_error", detail })));
    expect(document.body.textContent).toContain(detail);
    expect(document.body.textContent).not.toContain("isn't available");
  });

  it("saves the whole message as a file under the name the server gave it", async () => {
    const created: Blob[] = [];
    URL.createObjectURL = (b: Blob | MediaSource) => (created.push(b as Blob), "blob:x");
    URL.revokeObjectURL = () => {};
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe("Hi.eml");
    });
    const file = vi.fn().mockResolvedValue({ blob: new Blob([raw]), filename: "Hi.eml" });
    await show(() => Promise.resolve({ source: raw, size_bytes: raw.length, truncated: false }), file);
    const button = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => b.textContent === "Download .eml")!;
    await act(async () => button.click());
    await flush();
    expect(file).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    expect(created).toHaveLength(1);
  });
});
