import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import python from "highlight.js/lib/languages/python";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { Marked, marked } from "marked";
import { markedHighlight } from "marked-highlight";

hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("js", javascript);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("ts", typescript);
hljs.registerLanguage("python", python);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("sh", bash);
hljs.registerLanguage("shell", bash);
hljs.registerLanguage("json", json);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("yml", yaml);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("css", css);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("html", xml);

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function codeBlock({ text, lang }: { text: string; lang?: string }): string {
  // The info string is author text: only its first word names the language,
  // and it is escaped so it cannot leave the class attribute.
  const language = lang?.match(/^\S+/)?.[0];
  const langClass = language ? ` language-${escapeHtml(language)}` : "";
  return `<pre class="tila-codeblock"><code class="hljs${langClass}">${text}</code></pre>`;
}

const highlighting = {
  langPrefix: "hljs language-",
  highlight(code: string, lang: string): string {
    if (lang && hljs.getLanguage(lang)) {
      return hljs.highlight(code, { language: lang }).value;
    }
    return hljs.highlightAuto(code).value;
  },
};

const renderer = new marked.Renderer();
renderer.code = codeBlock;
marked.use(markedHighlight(highlighting), { renderer });

// The untrusted profile is for text a caller supplied and the page shows
// without being asked (journal report fields). It parses markdown only: raw
// HTML is shown as text, and images and form controls are not emitted at all,
// since an image is a request the reader's browser makes unprompted.
const untrustedRenderer = new marked.Renderer();
untrustedRenderer.code = codeBlock;
untrustedRenderer.html = ({
  text,
  block,
}: { text: string; block: boolean }): string =>
  block
    ? `<pre class="tila-codeblock"><code>${escapeHtml(text.trimEnd())}</code></pre>`
    : escapeHtml(text);
untrustedRenderer.image = ({ text }: { text: string }): string =>
  text ? `[image: ${escapeHtml(text)}]` : "[image]";
untrustedRenderer.checkbox = ({ checked }: { checked: boolean }): string =>
  checked ? "[x] " : "[ ] ";
const untrustedMarked = new Marked(markedHighlight(highlighting), {
  renderer: untrustedRenderer,
});

// A DOMPurify instance of its own, so the link hook and the allowlist below
// cannot leak into the default profile. Only what the renderer above can emit
// is allowed: no media, forms, styles or generic containers.
const untrustedPurify = DOMPurify(window);
untrustedPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.nodeName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer nofollow");
  }
});
const UNTRUSTED_SANITIZE = {
  ALLOWED_TAGS: [
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
  ],
  ALLOWED_ATTR: ["href", "title", "class", "start", "align"],
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
};

export type RenderMarkdownOptions = {
  /** Text a caller supplied and the page shows unprompted. See above. */
  untrusted?: boolean;
};

export function renderMarkdown(
  text: string,
  options: RenderMarkdownOptions = {},
): string {
  if (options.untrusted) {
    const rawHtml = untrustedMarked.parse(text, { async: false }) as string;
    return untrustedPurify.sanitize(rawHtml, UNTRUSTED_SANITIZE);
  }
  const rawHtml = marked.parse(text, { async: false }) as string;
  return DOMPurify.sanitize(rawHtml);
}
