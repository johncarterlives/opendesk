// What the attachment preview shows, and how. Nothing a browser would run is ever opened as
// itself: images go in <img> (which runs no script, whatever the file holds), a PDF opens in
// the browser's own viewer from a blob: URL typed application/pdf only once its bytes start
// with %PDF-, and text is put on the page as text, never as markup. Everything else downloads.

/** The previewable kinds; null for a file that only downloads. */
export type PreviewKind = "image" | "pdf" | "text";

/** An attachment as the preview needs it, whichever API it came from. */
export type PreviewFile = {
  id: string;
  filename: string;
  content_type: string;
  size: number;
  /** The signed link: downloads the file. */
  url: string;
  /** The link an <img> shows the picture from (Collab's ?inline=1). */
  imageUrl: string;
};

// The raster images the API serves inline (hd.InlineSafe). SVG is never shown, it can carry script.
const images = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp"];
// Types some mail clients give any file: the name decides what to try, the bytes decide.
const generic = ["application/octet-stream", "binary/octet-stream", "application/x-download", ""];
const textNames = /\.(txt|log|csv|tsv|md|json|ya?ml|ini|conf|cfg)$/i;

/** The largest text file the preview reads; a longer one downloads. */
export const MAX_TEXT_BYTES = 2 << 20;
/** The largest PDF the preview reads into memory. */
export const MAX_PDF_BYTES = 40 << 20;

const base = (type: string) => type.split(";")[0].trim().toLowerCase();

/** How a file is previewed, from its type and name, or null when it only downloads. */
export function previewKind(contentType: string, filename: string): PreviewKind | null {
  const t = base(contentType);
  if (images.includes(t)) return "image";
  if (t === "application/pdf" || t === "application/x-pdf") return "pdf";
  if (t.startsWith("text/") || t === "application/json" || t.endsWith("+json")) return "text";
  if (generic.includes(t)) {
    if (/\.pdf$/i.test(filename)) return "pdf";
    if (textNames.test(filename)) return "text";
  }
  return null;
}

/** The previewable files of a list, in their order. */
export function previewable<T extends PreviewFile>(files: T[]): T[] {
  return files.filter((f) => previewKind(f.content_type, f.filename) !== null);
}

/** Whether a file is too large to read for its preview. */
export function tooLarge(kind: PreviewKind, size: number): boolean {
  if (kind === "pdf") return size > MAX_PDF_BYTES;
  if (kind === "text") return size > MAX_TEXT_BYTES;
  return false;
}

/** Whether the bytes are a PDF: a PDF starts with `%PDF-`. */
export function isPdf(bytes: Uint8Array): boolean {
  const magic = [0x25, 0x50, 0x44, 0x46, 0x2d];
  return bytes.length >= magic.length && magic.every((b, i) => bytes[i] === b);
}

/** Whether the bytes look like text: no NUL in the first 8 KB, as git and grep decide. */
export function isText(bytes: Uint8Array): boolean {
  return !bytes.subarray(0, 8192).includes(0);
}

/** What the fetched bytes become: a PDF blob for the browser's viewer, text, or nothing. */
export type Loaded = { kind: "pdf"; blob: Blob } | { kind: "text"; text: string } | { kind: "refused" };

/** Checks the bytes against the kind the preview expected, and builds what it shows. */
export function fromBytes(kind: "pdf" | "text", bytes: Uint8Array): Loaded {
  if (kind === "pdf") {
    if (!isPdf(bytes)) return { kind: "refused" };
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return { kind: "pdf", blob: new Blob([copy], { type: "application/pdf" }) };
  }
  if (bytes.byteLength > MAX_TEXT_BYTES || !isText(bytes)) return { kind: "refused" };
  return { kind: "text", text: new TextDecoder("utf-8").decode(bytes) };
}

/**
 * The link the preview reads the file from. A ticket attachment link redirects to the file's
 * store, which a script cannot follow across origins; `stream=1` has the API send the bytes itself
 * (contracts/api.md "Attachments"). Collab links are already streamed by the API.
 */
export function fetchUrl(url: string): string {
  if (!/\/v1\/attachments\/[^/?#]+(\?|$)/.test(url)) return url;
  return `${url}${url.includes("?") ? "&" : "?"}stream=1`;
}

/** Whether this browser shows PDFs itself (false in some embedded browsers). */
export function pdfViewerAvailable(): boolean {
  return typeof navigator === "undefined" || navigator.pdfViewerEnabled !== false;
}
