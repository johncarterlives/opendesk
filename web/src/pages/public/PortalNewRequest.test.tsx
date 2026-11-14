import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import { customerPortal } from "@/lib/customerPortal/client";
import { MAX_FILES, NewRequest } from "./PortalNewRequest";

const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, className }: { children: ReactNode; className?: string }) => <a href="#" className={className}>{children}</a>,
  useNavigate: () => navigate,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => {
  vi.restoreAllMocks();
  navigate.mockReset();
  document.body.innerHTML = "";
});

async function mount() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  await act(async () => root.render(<QueryClientProvider client={client}><NewRequest slug="acme" /></QueryClientProvider>));
  return host;
}
const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
const setText = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
async function fill(host: HTMLElement, subject: string, body: string) {
  const input = host.querySelector<HTMLInputElement>('input[name="subject"]')!;
  const area = host.querySelector<HTMLTextAreaElement>('textarea[name="body"]')!;
  await act(async () => {
    setValue.call(input, subject);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    setText.call(area, body);
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const sendButton = (host: HTMLElement) => host.querySelector<HTMLButtonElement>('button[type="submit"]')!;
const submit = (host: HTMLElement) => act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));

describe("the portal's new request form", () => {
  it("asks for a subject and a message, and nothing the team sets", async () => {
    const host = await mount();
    expect(host.textContent).toContain("New request");
    // Two fields of text, and a file picker: nothing the team sets.
    expect([...host.querySelectorAll("input, textarea")].map((e) => e.getAttribute("name") ?? e.getAttribute("type"))).toEqual(["subject", "body", "file"]);
    expect(sendButton(host).disabled).toBe(true);
    await fill(host, "Order is late", "   ");
    expect(sendButton(host).disabled).toBe(true);
    await fill(host, "Order is late", "It has not arrived");
    expect(sendButton(host).disabled).toBe(false);
    expect(host.querySelector<HTMLInputElement>('input[name="subject"]')!.maxLength).toBe(200);
    expect(host.querySelector<HTMLTextAreaElement>('textarea[name="body"]')!.maxLength).toBe(10000);
  });

  it("sends the trimmed words for this portal and opens the request it made", async () => {
    const create = vi.spyOn(customerPortal, "create").mockResolvedValue({ id: "t-9", number: 9, subject: "Order is late", status: "open", created_at: "", updated_at: "" });
    const host = await mount();
    await fill(host, "  Order is late ", "  It has not arrived\n");
    await submit(host);
    expect(create).toHaveBeenCalledWith("acme", "Order is late", "It has not arrived", []);
    expect(navigate).toHaveBeenCalledWith({ to: "/portal/$slug/tickets/$ticketId", params: { slug: "acme", ticketId: "t-9" } });
  });

  it("says so when too many requests were sent, and keeps what was written", async () => {
    vi.spyOn(customerPortal, "create").mockRejectedValue(new ApiError({ status: 429, code: "rate_limited" }));
    const host = await mount();
    await fill(host, "Again", "Another one");
    await submit(host);
    await vi.waitFor(() => expect(host.textContent).toContain("several requests in a row"));
    expect(navigate).not.toHaveBeenCalled();
    expect(host.querySelector<HTMLInputElement>('input[name="subject"]')!.value).toBe("Again");
  });

  it.each([
    ["the help center's limit for everyone", "portal_busy", 429, "Many requests are arriving right now"],
    ["a portal turned off while the form was open", "not_found", 404, "This help center is not available"],
  ])("says what happened for %s, and keeps what was written", async (_, code, status, message) => {
    vi.spyOn(customerPortal, "create").mockRejectedValue(new ApiError({ status, code }));
    const host = await mount();
    await fill(host, "Help", "Please");
    await submit(host);
    await vi.waitFor(() => expect(host.textContent).toContain(message));
    expect(host.textContent).not.toContain("several requests in a row");
    expect(navigate).not.toHaveBeenCalled();
    expect(host.querySelector<HTMLTextAreaElement>('textarea[name="body"]')!.value).toBe("Please");
  });

  it("shows the general message for any other failure", async () => {
    vi.spyOn(customerPortal, "create").mockRejectedValue(new ApiError({ status: 500 }));
    const host = await mount();
    await fill(host, "x", "y");
    await submit(host);
    await vi.waitFor(() => expect(host.textContent).toContain("Something went wrong"));
  });

  describe("files", () => {
    const file = (name: string, type = "text/plain", bytes = 10) => new File([new Uint8Array(bytes)], name, { type });
    const choose = async (host: HTMLElement, files: File[]) => {
      const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
      Object.defineProperty(input, "files", { value: files, configurable: true });
      await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    };
    const stubUrls = () => {
      vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:preview"), revokeObjectURL: vi.fn() }));
    };
    const upload = (id: string) => ({ id, filename: "", content_type: "", size_bytes: 1, url: "", inline: false });

    it("uploads a chosen file at once, shows it, and sends its id with the request", async () => {
      stubUrls();
      const up = vi.spyOn(customerPortal, "upload").mockResolvedValue(upload("a-1"));
      const create = vi.spyOn(customerPortal, "create").mockResolvedValue({ id: "t-1", number: 1, subject: "s", status: "open", created_at: "", updated_at: "" });
      const host = await mount();
      await choose(host, [file("notes.txt")]);
      expect(up).toHaveBeenCalledWith("acme", expect.objectContaining({ name: "notes.txt" }));
      await vi.waitFor(() => expect(host.textContent).toContain("1 KB"));
      await fill(host, "Subject", "Message");
      await submit(host);
      expect(create).toHaveBeenCalledWith("acme", "Subject", "Message", ["a-1"]);
    });

    it("takes a screenshot pasted into the form, as a picture", async () => {
      stubUrls();
      const up = vi.spyOn(customerPortal, "upload").mockResolvedValue(upload("a-2"));
      const host = await mount();
      const paste = new Event("paste", { bubbles: true, cancelable: true });
      Object.assign(paste, { clipboardData: { files: [file("image.png", "image/png")] } });
      await act(async () => host.querySelector("textarea")!.dispatchEvent(paste));
      expect(up).toHaveBeenCalledTimes(1);
      expect(paste.defaultPrevented).toBe(true);
      expect(host.querySelector("li img")).not.toBeNull();
      // Pasted text is left to the field.
      const text = new Event("paste", { bubbles: true, cancelable: true });
      Object.assign(text, { clipboardData: { files: [] } });
      await act(async () => host.querySelector("textarea")!.dispatchEvent(text));
      expect(text.defaultPrevented).toBe(false);
      expect(up).toHaveBeenCalledTimes(1);
    });

    it("takes dropped files", async () => {
      stubUrls();
      const up = vi.spyOn(customerPortal, "upload").mockResolvedValue(upload("a-3"));
      const host = await mount();
      const drop = new Event("drop", { bubbles: true, cancelable: true });
      Object.assign(drop, { dataTransfer: { files: [file("a.pdf", "application/pdf")] } });
      await act(async () => host.querySelector("[data-over], .border-dashed")!.dispatchEvent(drop));
      expect(up).toHaveBeenCalledTimes(1);
    });

    it("holds the request back while a file uploads, and drops a removed one from it", async () => {
      stubUrls();
      let finish!: (u: ReturnType<typeof upload>) => void;
      vi.spyOn(customerPortal, "upload").mockReturnValueOnce(new Promise((r) => { finish = r; })).mockResolvedValueOnce(upload("keep"));
      const create = vi.spyOn(customerPortal, "create").mockResolvedValue({ id: "t", number: 1, subject: "s", status: "open", created_at: "", updated_at: "" });
      const host = await mount();
      await fill(host, "Subject", "Message");
      await choose(host, [file("slow.txt")]);
      expect(host.textContent).toContain("Uploading");
      expect(sendButton(host).disabled).toBe(true);
      await act(async () => finish(upload("slow")));
      expect(sendButton(host).disabled).toBe(false);
      await choose(host, [file("keep.txt")]);
      await vi.waitFor(() => expect(host.textContent).not.toContain("Uploading"));
      await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Remove slow.txt"]')!.click());
      await submit(host);
      expect(create).toHaveBeenCalledWith("acme", "Subject", "Message", ["keep"]);
    });

    it("refuses a file over 10 MB and more than five files before uploading, and shows a failed upload", async () => {
      stubUrls();
      const up = vi.spyOn(customerPortal, "upload").mockResolvedValue(upload("ok"));
      const host = await mount();
      await choose(host, [{ ...file("big.txt"), size: 10 * 1024 * 1024 + 1, name: "big.txt", type: "text/plain" } as unknown as File]);
      expect(up).not.toHaveBeenCalled();
      expect(host.textContent).toContain("big.txt is over 10 MB.");
      await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Remove big.txt"]')!.click());

      await choose(host, Array.from({ length: MAX_FILES + 1 }, (_, n) => file(`f${n}.txt`)));
      expect(up).toHaveBeenCalledTimes(MAX_FILES);
      expect(host.textContent).toContain("up to 5 files");

      up.mockRejectedValueOnce(new ApiError({ status: 422 }));
      await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Remove f0.txt"]')!.click());
      await choose(host, [file("bad.exe")]);
      await vi.waitFor(() => expect(host.textContent).toContain("bad.exe could not be uploaded."));
      // A failed file is not sent with the request.
      expect(sendButton(host).disabled).toBe(true);
    });
  });
});
