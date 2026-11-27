import { describe, expect, it } from "vitest";
import { htmlToMarkdown } from "./markdown";

describe("htmlToMarkdown", () => {
  it("turns a wiki page into markdown the agent reads", () => {
    const html =
      "<h2>Create a Linear issue</h2><p>Use the <strong>Platform</strong> team, see <a href=\"https://linear.app/acme\">the board</a>.</p>" +
      "<ol><li>Collect the steps</li><li>Set the priority<ul><li>Urgent for outages</li></ul></li></ol>" +
      "<blockquote><p>Never promise a date.</p></blockquote><pre><code>status: triage\n</code></pre><p>Line<br>break with <em>care</em> and <code>code</code>.</p>";
    expect(htmlToMarkdown(html)).toBe(
      [
        "## Create a Linear issue",
        "Use the **Platform** team, see [the board](https://linear.app/acme).",
        "1. Collect the steps\n2. Set the priority\n   - Urgent for outages",
        "> Never promise a date.",
        "```\nstatus: triage\n```",
        "Line\nbreak with *care* and `code`.",
      ].join("\n\n"),
    );
  });

  it("drops images, scripts' text stays text, and links that are not web addresses", () => {
    expect(htmlToMarkdown('<p><img src="https://x.test/a.png">Hi <a href="javascript:alert(1)">there</a></p>')).toBe("Hi there");
    expect(htmlToMarkdown("")).toBe("");
  });

  it("turns images into what the caller names, and leaves out styles and scripts", () => {
    const html = '<style>p{color:red}</style><p>See <img src="https://x.test/a.png" alt="graph"> here</p><script>x()</script>';
    expect(htmlToMarkdown(html, { image: (img) => `[image: ${img.alt}]` })).toBe("See [image: graph] here");
    expect(htmlToMarkdown(html)).toBe("See here");
  });

  it("keeps a table's cells apart", () => {
    expect(htmlToMarkdown("<table><tr><td>Plan</td><td>Pro</td></tr><tr><td>Seats</td><td>5</td></tr></table>")).toBe("Plan Pro\n\nSeats 5");
  });
});
