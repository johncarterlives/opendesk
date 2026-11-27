import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/i18n";
import { i18n } from "@/i18n";
import { AttachmentList, type PreviewFile } from "./Attachments";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  await i18n.changeLanguage("en");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  URL.createObjectURL = vi.fn(() => "blob:preview");
  URL.revokeObjectURL = vi.fn();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const file = (id: string, filename: string, content_type: string, url = `https://api.example.com/v1/attachments/${id}?exp=1&sig=2`): PreviewFile => ({
  id,
  filename,
  content_type,
  size: 1200,
  url,
  imageUrl: url,
});

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const dialog = () => document.querySelector<HTMLElement>("[role=dialog]");
const byLabel = (label: string) => document.querySelector<HTMLElement>(`[aria-label="${label}"]`)!;
const press = (key: string) => act(async () => { dialog()!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })); });

function respond(bodies: Record<string, string>) {
  const fetch = vi.fn(async (url: string) => {
    const id = /attachments\/(\w+)/.exec(url)![1];
    return new Response(bodies[id], { status: 200 });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

async function show(files: PreviewFile[]) {
  await act(async () => root.render(<AttachmentList files={files} />));
}

describe("AttachmentList", () => {
  it("opens a PDF in the browser's viewer from a checked blob, streamed by the API", async () => {
    const fetch = respond({ a: "%PDF-1.4\n%%EOF" });
    await show([file("a", "invoice.pdf", "application/pdf")]);
    await act(async () => byLabel("Preview invoice.pdf").click());
    await flush();
    expect(fetch.mock.calls[0][0]).toBe("https://api.example.com/v1/attachments/a?exp=1&sig=2&stream=1");
    const frame = dialog()!.querySelector("iframe")!;
    expect(frame.getAttribute("src")).toBe("blob:preview");
    const blob = (URL.createObjectURL as ReturnType<typeof vi.fn>).mock.calls[0][0] as Blob;
    expect(blob.type).toBe("application/pdf");
  });

  it("refuses a PDF whose bytes are not one, and offers the download", async () => {
    respond({ a: "<html><script>parent.alert(1)</script></html>" });
    await show([file("a", "invoice.pdf", "application/pdf")]);
    await act(async () => byLabel("Preview invoice.pdf").click());
    await flush();
    expect(dialog()!.querySelector("iframe")).toBeNull();
    expect(dialog()!.textContent).toContain("This file can't be shown here");
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(dialog()!.querySelector("a[download]")!.getAttribute("href")).toBe("https://api.example.com/v1/attachments/a?exp=1&sig=2");
  });

  it("shows text as text, never as markup", async () => {
    respond({ t: "<img src=x onerror=alert(1)>" });
    await show([file("t", "notes.txt", "text/plain")]);
    await act(async () => byLabel("Preview notes.txt").click());
    await flush();
    expect(dialog()!.querySelector("pre")!.textContent).toBe("<img src=x onerror=alert(1)>");
    expect(dialog()!.querySelector("img")).toBeNull();
  });

  it("steps through the message's previewable files with the arrows, and Escape closes", async () => {
    respond({ b: "%PDF-1.4", c: "log line" });
    await show([file("a", "photo.png", "image/png"), file("z", "archive.zip", "application/zip"), file("b", "invoice.pdf", "application/pdf"), file("c", "server.log", "text/plain")]);
    expect(byLabel("Download archive.zip").tagName).toBe("A");
    await act(async () => byLabel("Preview photo.png").click());
    expect(dialog()!.textContent).toContain("photo.png");
    expect(dialog()!.textContent).toContain("1 of 3");
    await press("ArrowRight");
    await flush();
    expect(dialog()!.textContent).toContain("invoice.pdf");
    await press("ArrowRight");
    await flush();
    expect(dialog()!.textContent).toContain("server.log");
    await press("ArrowRight");
    expect(dialog()!.textContent).toContain("photo.png");
    await press("ArrowLeft");
    await flush();
    expect(dialog()!.textContent).toContain("server.log");
    await act(async () => byLabel("Previous file").click());
    await flush();
    expect(dialog()!.textContent).toContain("invoice.pdf");
    await press("Escape");
    await flush();
    expect(dialog()).toBeNull();
  });

  it("closes on a click beside the file", async () => {
    await show([file("a", "photo.png", "image/png")]);
    await act(async () => byLabel("Preview photo.png").click());
    expect(dialog()).not.toBeNull();
    await act(async () => dialog()!.querySelector<HTMLElement>("img")!.click());
    expect(dialog()).not.toBeNull();
    await act(async () => dialog()!.click());
    await flush();
    expect(dialog()).toBeNull();
  });
});
