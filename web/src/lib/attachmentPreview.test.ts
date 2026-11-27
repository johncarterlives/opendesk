import { describe, expect, it } from "vitest";
import { samplePdf } from "@/mock/samplePdf";
import { fetchUrl, fromBytes, isPdf, MAX_TEXT_BYTES, previewKind, tooLarge } from "./attachmentPreview";

const enc = (s: string) => new TextEncoder().encode(s);

describe("previewKind", () => {
  it("previews raster images, PDFs and text", () => {
    expect(previewKind("image/png", "a.png")).toBe("image");
    expect(previewKind("IMAGE/JPEG; name=a.jpg", "a.jpg")).toBe("image");
    expect(previewKind("application/pdf", "a.pdf")).toBe("pdf");
    expect(previewKind("text/plain; charset=utf-8", "notes.txt")).toBe("text");
    expect(previewKind("text/csv", "export.csv")).toBe("text");
    expect(previewKind("application/json", "data.json")).toBe("text");
  });

  it("never shows SVG as a picture, and other files only download", () => {
    expect(previewKind("image/svg+xml", "logo.svg")).toBeNull();
    expect(previewKind("image/tiff", "scan.tiff")).toBeNull();
    expect(previewKind("application/zip", "a.zip")).toBeNull();
    expect(previewKind("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "a.docx")).toBeNull();
    expect(previewKind("audio/mpeg", "a.mp3")).toBeNull();
  });

  it("shows an active document as its text, never as itself", () => {
    expect(previewKind("text/html", "page.html")).toBe("text");
    expect(previewKind("application/xhtml+xml", "page.xhtml")).toBeNull();
  });

  it("goes by the name only for a file sent with a generic type", () => {
    expect(previewKind("application/octet-stream", "Invoice.PDF")).toBe("pdf");
    expect(previewKind("", "server.log")).toBe("text");
    expect(previewKind("application/octet-stream", "setup.exe")).toBeNull();
    expect(previewKind("application/zip", "fake.pdf")).toBeNull();
  });
});

describe("fromBytes", () => {
  it("opens a PDF only when its bytes start with %PDF-, typed application/pdf", () => {
    const ok = fromBytes("pdf", enc("%PDF-1.7\n..."));
    expect(ok.kind).toBe("pdf");
    expect(ok.kind === "pdf" && ok.blob.type).toBe("application/pdf");
    expect(fromBytes("pdf", enc("<html><script>alert(1)</script>")).kind).toBe("refused");
    expect(fromBytes("pdf", enc(" %PDF-1.7")).kind).toBe("refused");
    expect(fromBytes("pdf", enc("%PD")).kind).toBe("refused");
  });

  it("reads text as text, and refuses binary or oversized files", () => {
    const html = "<img src=x onerror=alert(1)>";
    expect(fromBytes("text", enc(html))).toEqual({ kind: "text", text: html });
    expect(fromBytes("text", new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00])).kind).toBe("refused");
    expect(fromBytes("text", new Uint8Array(MAX_TEXT_BYTES + 1).fill(0x61)).kind).toBe("refused");
  });
});

describe("tooLarge", () => {
  it("limits what the preview reads, by kind", () => {
    expect(tooLarge("text", MAX_TEXT_BYTES)).toBe(false);
    expect(tooLarge("text", MAX_TEXT_BYTES + 1)).toBe(true);
    expect(tooLarge("pdf", 25 << 20)).toBe(false);
    expect(tooLarge("image", 1 << 30)).toBe(false);
  });
});

describe("fetchUrl", () => {
  it("asks the API to stream a ticket attachment instead of redirecting to its store", () => {
    expect(fetchUrl("https://api.example.com/v1/attachments/abc?exp=1&sig=2")).toBe("https://api.example.com/v1/attachments/abc?exp=1&sig=2&stream=1");
    expect(fetchUrl("/v1/attachments/abc")).toBe("/v1/attachments/abc?stream=1");
  });

  it("leaves Collab links and data: URLs alone", () => {
    const collab = "https://api.example.com/v1/collab/attachments/m1/0?exp=1&sig=2";
    expect(fetchUrl(collab)).toBe(collab);
    expect(fetchUrl("data:application/pdf;base64,JVBERi0=")).toBe("data:application/pdf;base64,JVBERi0=");
  });
});

describe("samplePdf", () => {
  it("is a real PDF the preview opens", () => {
    const url = samplePdf("Invoice (draft) – 1", ["Total $1"]);
    const bin = atob(url.split(",")[1]);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    expect(isPdf(bytes)).toBe(true);
    expect(bin).toContain("(Invoice \\(draft\\) ? 1)");
    expect(bin.trimEnd().endsWith("%%EOF")).toBe(true);
  });
});
