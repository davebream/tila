import { renderMarkdown } from "@/lib/markdown";
import { describe, expect, it } from "vitest";

/** Parse into an inert document: nothing here can load or run. */
const parse = (html: string) =>
  new DOMParser().parseFromString(html, "text/html").body;
const trusted = (markdown: string) => parse(renderMarkdown(markdown));
const untrusted = (markdown: string) =>
  parse(renderMarkdown(markdown, { untrusted: true }));

const attributeNames = (root: Element) =>
  [...root.querySelectorAll("*")].flatMap((el) =>
    [...el.attributes].map((attr) => attr.name),
  );

describe("renderMarkdown", () => {
  describe("code fence language", () => {
    it("keeps highlighting and the language class for a plain language", () => {
      const body = trusted("```ts\nconst answer: number = 42;\n```");
      const code = body.querySelector("pre.tila-codeblock > code");
      expect(code?.className).toBe("hljs language-ts");
      expect(code?.querySelector("span[class^='hljs-']")).not.toBeNull();
      expect(code?.textContent).toContain("const answer: number = 42;");
    });

    it("cannot be used to inject attributes through the info string", () => {
      const body = trusted(
        '```x"style="position:fixed;inset:0;background:red\ncode\n```\n\n```js onmouseover=alert(1)\nvar a = 1;\n```',
      );
      const codes = [...body.querySelectorAll("pre > code")];
      expect(codes).toHaveLength(2);
      for (const code of codes) {
        expect(code.getAttributeNames()).toEqual(["class"]);
      }
      expect(codes[1].className).toBe("hljs language-js");
    });
  });

  describe("default profile", () => {
    it("still removes scripts, event handlers and script URLs", () => {
      const body = trusted(
        '<script>alert(1)</script><img src=x onerror="alert(1)">\n\n[a](javascript:alert(1))',
      );
      expect(body.querySelector("script")).toBeNull();
      expect(attributeNames(body).some((name) => name.startsWith("on"))).toBe(
        false,
      );
      expect(body.querySelector("a")?.hasAttribute("href")).toBe(false);
    });
  });

  describe("untrusted profile", () => {
    it("renders headings, lists, links, inline code and code blocks", () => {
      const body = untrusted(
        [
          "# Title",
          "",
          "## Details",
          "",
          "- first",
          "- second **bold**",
          "",
          "1. one",
          "2. two",
          "",
          "See [the run](https://ci.example/run/1?a=1&b=2) and `pnpm test`.",
          "",
          "> quoted",
          "",
          "```sh",
          "pnpm test",
          "```",
        ].join("\n"),
      );
      expect(body.querySelector("h1")?.textContent).toBe("Title");
      expect(body.querySelector("h2")?.textContent).toBe("Details");
      expect(
        [...body.querySelectorAll("ul > li")].map((li) => li.textContent),
      ).toEqual(["first", "second bold"]);
      expect(body.querySelector("ul strong")?.textContent).toBe("bold");
      expect(
        [...body.querySelectorAll("ol > li")].map((li) => li.textContent),
      ).toEqual(["one", "two"]);
      const link = body.querySelector("a");
      expect(link?.getAttribute("href")).toBe(
        "https://ci.example/run/1?a=1&b=2",
      );
      expect(link?.textContent).toBe("the run");
      expect(body.querySelector("p > code")?.textContent).toBe("pnpm test");
      expect(body.querySelector("blockquote")?.textContent?.trim()).toBe(
        "quoted",
      );
      const block = body.querySelector("pre.tila-codeblock > code");
      expect(block?.className).toBe("hljs language-sh");
      expect(block?.textContent?.trim()).toBe("pnpm test");
    });

    it("renders tables", () => {
      const body = untrusted("| a | b |\n|:-:|---|\n| 1 | 2 |");
      expect(body.querySelectorAll("th")).toHaveLength(2);
      expect(body.querySelectorAll("td")).toHaveLength(2);
    });

    it("shows raw HTML as text instead of parsing it", () => {
      const markup = [
        "<script>alert(1)</script>",
        "<img src=x onerror=alert(1)>",
        "<svg onload=alert(1)></svg>",
        "<iframe src=https://evil.example></iframe>",
        "<style>*{display:none}</style>",
        '<div class="fixed inset-0 z-50 bg-background">Session expired</div>',
        '<form action="https://evil.example"><input name=token><button>go</button></form>',
        '<a href="javascript:alert(1)" onclick="alert(1)">x</a>',
      ];
      // Both block-level and inline placements.
      const body = untrusted(
        `${markup.join("\n\n")}\n\nsome text ${markup.join(" ")} more text`,
      );
      expect(
        body.querySelectorAll(
          "script, style, img, svg, iframe, div, form, input, button, object, embed, link, meta",
        ),
      ).toHaveLength(0);
      expect(body.querySelector("a")).toBeNull();
      expect(attributeNames(body).some((name) => name.startsWith("on"))).toBe(
        false,
      );
      const text = body.textContent ?? "";
      for (const snippet of markup) expect(text).toContain(snippet);
    });

    it("removes script URLs from links but keeps their text", () => {
      const hostile = [
        "javascript:alert(1)",
        "JaVaScRiPt:alert(1)",
        "<java\tscript:alert(1)>",
        "jav&#x09;ascript:alert(1)",
        "&#106;avascript:alert(1)",
        "&#x6A;&#x61;vascript&colon;alert(1)",
        "vbscript:msgbox(1)",
        "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
      ];
      const body = untrusted(
        hostile.map((url, i) => `[link${i}](${url})`).join("\n\n"),
      );
      const anchors = [...body.querySelectorAll("a")];
      expect(anchors.map((a) => a.textContent)).toEqual(
        hostile.map((_, i) => `link${i}`),
      );
      // Whatever href survives must resolve to a web or mail URL.
      for (const anchor of anchors) {
        const href = anchor.getAttribute("href");
        if (href === null) continue;
        expect(["https:", "mailto:"]).toContain(
          new URL(href, "https://app.example/").protocol,
        );
      }
    });

    it("keeps web and mail links and makes them open safely", () => {
      const body = untrusted(
        "[web](https://example.com/x) [mail](mailto:ops@example.com) [rel](/p/test/tasks/T-1)",
      );
      const anchors = [...body.querySelectorAll("a")];
      expect(anchors.map((a) => a.getAttribute("href"))).toEqual([
        "https://example.com/x",
        "mailto:ops@example.com",
        "/p/test/tasks/T-1",
      ]);
      for (const anchor of anchors) {
        expect(anchor.getAttribute("target")).toBe("_blank");
        expect(anchor.getAttribute("rel")).toBe("noopener noreferrer nofollow");
      }
    });

    it("cannot be broken out of through a link title", () => {
      const body = untrusted(
        '[a](https://example.com "x\\" onmouseover=\\"alert(1)")',
      );
      const anchor = body.querySelector("a");
      expect(anchor?.getAttribute("onmouseover")).toBeNull();
      expect(attributeNames(body).some((name) => name.startsWith("on"))).toBe(
        false,
      );
    });

    it("never fetches images: shows their alt text", () => {
      const body = untrusted(
        [
          "![build graph](https://tracker.example/p.png)",
          "",
          "![](https://tracker.example/q.png)",
          "",
          "[![linked](https://tracker.example/r.png)](https://example.com/run)",
          "",
          '![a & <b onclick="x">](https://tracker.example/s.png)',
        ].join("\n"),
      );
      expect(body.querySelector("img, b")).toBeNull();
      const paragraphs = [...body.querySelectorAll("p")].map(
        (p) => p.textContent,
      );
      expect(paragraphs).toEqual([
        "[image: build graph]",
        "[image]",
        "[image: linked]",
        '[image: a & <b onclick="x">]',
      ]);
      expect(body.querySelector("a")?.getAttribute("href")).toBe(
        "https://example.com/run",
      );
    });

    it("cannot inject attributes through a code fence info string", () => {
      const body = untrusted(
        '```x"style="position:fixed;inset:0\ncode\n```\n\n```js onmouseover=alert(1)\nvar a = 1;\n```',
      );
      for (const code of body.querySelectorAll("pre > code")) {
        expect(code.getAttributeNames()).toEqual(["class"]);
      }
    });

    it("escapes markup inside code blocks", () => {
      const body = untrusted(
        '```html\n<img src=x onerror="alert(1)">\n<script>alert(1)</script>\n```',
      );
      expect(body.querySelector("pre img, pre script")).toBeNull();
      expect(body.querySelector("pre code")?.textContent).toContain(
        "<script>alert(1)</script>",
      );
    });

    it("renders task lists without form controls", () => {
      const body = untrusted("- [x] built\n- [ ] deployed");
      expect(body.querySelector("input")).toBeNull();
      expect(
        [...body.querySelectorAll("li")].map((li) => li.textContent?.trim()),
      ).toEqual(["[x] built", "[ ] deployed"]);
    });

    it("emits only allowlisted tags and attributes for a mixed document", () => {
      const body = untrusted(
        [
          "# h",
          "<b onclick=x>raw</b> **md** ~~gone~~ `c`",
          "",
          "- [x] a",
          "",
          "3. start",
          "",
          "| a |\n|---|\n| b |",
          "",
          "---",
          "",
          "![i](https://x.example/i.png) [l](https://x.example 't')",
          "",
          "```js",
          "let a = '<b>';",
          "```",
          "<details><summary>s</summary>t</details>",
        ].join("\n"),
      );
      const tags = new Set(
        [...body.querySelectorAll("*")].map((el) => el.tagName.toLowerCase()),
      );
      const allowedTags = new Set([
        "a",
        "blockquote",
        "br",
        "code",
        "del",
        "em",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "hr",
        "li",
        "ol",
        "p",
        "pre",
        "span",
        "strong",
        "table",
        "tbody",
        "td",
        "th",
        "thead",
        "tr",
        "ul",
      ]);
      for (const tag of tags) expect(allowedTags.has(tag)).toBe(true);
      const allowedAttrs = new Set([
        "href",
        "title",
        "class",
        "start",
        "align",
        "target",
        "rel",
      ]);
      for (const name of attributeNames(body))
        expect(allowedAttrs.has(name)).toBe(true);
    });
  });
});
