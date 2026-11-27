// Sanitized HTML as plain markdown: a wiki page copied into a procedure's
// instructions, or a message copied for an AI agent (lib/agentPrompt.ts).

const BLOCKS = new Set(["P", "DIV", "H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "LI", "BLOCKQUOTE", "PRE", "HR", "TABLE", "TR"]);
/** Elements whose text is never what the page says: a designed email's styles, a template. */
const SKIP = new Set(["STYLE", "SCRIPT", "NOSCRIPT", "TEMPLATE", "HEAD", "TITLE"]);

export type MarkdownOptions = {
  /** What an image becomes; left out, or null, it is dropped. */
  image?: (img: HTMLImageElement) => string | null;
};


/** Inline markdown of an element's children: bold, italics, code, links and line breaks. */
function inline(node: Node, o: MarkdownOptions): string {
  let out = "";
  node.childNodes.forEach((c) => {
    if (c.nodeType === Node.TEXT_NODE) {
      const text = (c.textContent ?? "").replace(/\s+/g, " ");
      out += out.endsWith(" ") && text.startsWith(" ") ? text.slice(1) : text;
      return;
    }
    if (c.nodeType !== Node.ELEMENT_NODE) return;
    const el = c as HTMLElement;
    if (SKIP.has(el.tagName)) return;
    const inner = inline(el, o);
    switch (el.tagName) {
      case "BR":
        out += "\n";
        break;
      case "STRONG":
      case "B":
        out += inner.trim() ? `**${inner.trim()}**` : "";
        break;
      case "EM":
      case "I":
        out += inner.trim() ? `*${inner.trim()}*` : "";
        break;
      case "CODE":
        out += `\`${el.textContent ?? ""}\``;
        break;
      case "A": {
        const href = el.getAttribute("href") ?? "";
        out += /^(https?:|mailto:)/i.test(href) && inner.trim() ? `[${inner.trim()}](${href})` : inner;
        break;
      }
      case "IMG":
        out += o.image?.(el as HTMLImageElement) ?? "";
        break;
      case "TD":
      case "TH":
        out += inner.trim() ? `${inner.trim()} ` : "";
        break;
      default:
        out += BLOCKS.has(el.tagName) ? `\n${block(el, "", o).trim()}\n` : inner;
    }
  });
  return out;
}

/** Markdown of one block element; `indent` prefixes nested list items. */
function block(el: HTMLElement, indent: string, o: MarkdownOptions): string {
  switch (el.tagName) {
    case "H1":
    case "H2":
    case "H3":
    case "H4":
    case "H5":
    case "H6":
      return `${"#".repeat(Number(el.tagName[1]))} ${inline(el, o).trim()}`;
    case "UL":
    case "OL": {
      const ordered = el.tagName === "OL";
      const items = [...el.children].filter((c) => c.tagName === "LI") as HTMLElement[];
      return items
        .map((li, i) => {
          const nested = [...li.children].filter((c) => c.tagName === "UL" || c.tagName === "OL") as HTMLElement[];
          const clone = li.cloneNode(true) as HTMLElement;
          clone.querySelectorAll(":scope > ul, :scope > ol").forEach((n) => n.remove());
          const text = inline(clone, o).trim().replace(/\n+/g, " ");
          const sub = nested.map((n) => block(n, `${indent}   `, o)).join("\n");
          return `${indent}${ordered ? `${i + 1}.` : "-"} ${text}${sub ? `\n${sub}` : ""}`;
        })
        .join("\n");
    }
    case "BLOCKQUOTE":
      return children(el, o)
        .split("\n")
        .map((l) => (l ? `> ${l}` : ">"))
        .join("\n");
    case "PRE":
      return "```\n" + (el.textContent ?? "").replace(/\n$/, "") + "\n```";
    case "HR":
      return "---";
    default:
      return [...el.children].some((c) => BLOCKS.has(c.tagName)) ? children(el, o) : inline(el, o).trim();
  }
}

/** Markdown of a container's children, one blank line between blocks. */
function children(root: Element, o: MarkdownOptions): string {
  const parts: string[] = [];
  let loose = "";
  const flush = () => {
    if (loose.trim()) parts.push(loose.trim());
    loose = "";
  };
  root.childNodes.forEach((c) => {
    if (c.nodeType === Node.ELEMENT_NODE && SKIP.has((c as Element).tagName)) return;
    if (c.nodeType === Node.ELEMENT_NODE && BLOCKS.has((c as Element).tagName)) {
      flush();
      const md = block(c as HTMLElement, "", o);
      if (md.trim()) parts.push(md);
    } else if (c.nodeType === Node.TEXT_NODE || c.nodeType === Node.ELEMENT_NODE) {
      const holder = document.createElement("span");
      holder.appendChild(c.cloneNode(true));
      loose += inline(holder, o);
    }
  });
  flush();
  return parts.join("\n\n");
}

/** Sanitized rich text (a wiki page's body, contracts/wiki.md "Body", or a message's) as markdown. */
export function htmlToMarkdown(html: string, options: MarkdownOptions = {}): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  return children(doc.body, options)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
