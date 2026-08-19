import { parseNote, withResolvedUrls } from "../src/host/note-blocks"
import { page, renderNote } from "../src/host/note-html"
import type { NoteBlock } from "../src/protocol"

/**
 * The preview, which is the claim worth testing here.
 *
 * Everything else in this extension needs VS Code to run — a custom editor, a
 * webview, a `WorkspaceEdit`. This does not: it is the app's own `note-html.ts`,
 * carried over unchanged, plus the one rewrite that replaces the scheme it used
 * to resolve pictures through. If the walk still renders and a relative path
 * still becomes something a webview can load, the port of that file held.
 *
 * Plain asserts and a count, in the style of the app's `test/` scripts (see
 * `test/harness.ts` there for the reasoning). A real port would share that
 * harness rather than counting by hand.
 */

let failures = 0

function check(what: string, ok: boolean, detail?: unknown) {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}`)
  if (!ok) {
    failures += 1
    if (detail !== undefined) console.log(`       ${String(detail)}`)
  }
}

const BASE = "https://file+.vscode-resource.vscode-cdn.net/notes"

const BLOCKS: NoteBlock[] = [
  {
    type: "heading",
    props: { level: 2 },
    content: [{ type: "text", text: "Endpoints", styles: {} }],
  },
  {
    type: "paragraph",
    content: [
      { type: "text", text: "Send ", styles: { bold: true } },
      { type: "text", text: "POST", styles: { code: true } },
      { type: "text", text: " to ", styles: {} },
      {
        type: "link",
        href: "https://example.test/hook",
        content: [{ type: "text", text: "the hook", styles: {} }],
      },
    ],
  },
  // A picture this extension stored: a path relative to the note's directory.
  {
    type: "image",
    props: { url: "spec.note.assets/shape.png", name: "shape.png" },
  },
  // One embedded from the web, which is nobody's file and is left alone.
  { type: "image", props: { url: "https://example.test/logo.png" } },
  // A document that names a file outside its own directory. It is a file on
  // disk and could say anything, so this is the one that must not resolve.
  { type: "image", props: { url: "../../.ssh/id_rsa", caption: "no" } },
  {
    type: "paragraph",
    content: [{ type: "text", text: "<script>alert(1)</script>", styles: {} }],
  },
  // The three alignments a note can carry, plus the default it need not say.
  {
    type: "paragraph",
    props: { textAlignment: "center" },
    content: [{ type: "text", text: "middle", styles: {} }],
  },
  {
    type: "heading",
    props: { level: 3, textAlignment: "right", textColor: "blue" },
    content: [{ type: "text", text: "flush right", styles: {} }],
  },
  {
    type: "paragraph",
    props: { textAlignment: "left" },
    content: [{ type: "text", text: "plain", styles: {} }],
  },
  // A file could say anything; an alignment is a keyword off a list or nothing.
  {
    type: "paragraph",
    props: { textAlignment: "center;color:red" },
    content: [{ type: "text", text: "forged", styles: {} }],
  },
  {
    type: "image",
    props: { url: "https://example.test/wide.png", textAlignment: "center" },
  },
  // A list whose items disagree: the marker has to travel with the words of the
  // one that moved, and stay put for the one that did not.
  {
    type: "numberedListItem",
    props: { textAlignment: "center" },
    content: [{ type: "text", text: "moved", styles: {} }],
  },
  {
    type: "numberedListItem",
    content: [{ type: "text", text: "stayed", styles: {} }],
  },
]

console.log("\n# the document, resolved")
const resolved = withResolvedUrls(BLOCKS, BASE)
check(
  "a stored picture becomes a URL the webview can load",
  resolved[2]?.props?.url === `${BASE}/spec.note.assets/shape.png`,
  resolved[2]?.props?.url
)
check(
  "an embedded image is left as it was",
  resolved[3]?.props?.url === "https://example.test/logo.png"
)
check(
  "a path climbing out of the note's directory is not resolved",
  resolved[4]?.props?.url === "../../.ssh/id_rsa",
  resolved[4]?.props?.url
)
check(
  "and the document it was handed is untouched",
  BLOCKS[2]?.props?.url === "spec.note.assets/shape.png"
)

console.log("\n# the page")
const html = page(
  "Spec",
  "v1",
  `<article>${renderNote(resolved, new Map())}</article>`
)
check("is a whole document", html.startsWith("<!doctype html>"))
check("carries the note's name", html.includes("<title>Spec</title>"))
check(
  "renders headings",
  html.includes("<h2>"),
  html.match(/<h2[\s\S]*?<\/h2>/)?.[0]
)
check(
  "renders inline styles and links",
  html.includes("<strong>Send </strong>") &&
    html.includes("<code>POST</code>") &&
    html.includes('<a href="https://example.test/hook"'),
  html.match(/<p>Send[\s\S]*?<\/p>/)?.[0]
)
check(
  "draws the resolved picture",
  html.includes(`<img src="${BASE}/spec.note.assets/shape.png"`),
  html.match(/<img[^>]*>/g)?.join(" ")
)
check(
  "says so for the one it would not resolve, rather than linking it",
  !html.includes(".ssh") && html.includes('<p class="missing">no</p>'),
  html.match(/[^"]*\.ssh[^"]*/)?.[0]
)
check(
  "escapes the note's own markup",
  html.includes("&lt;script&gt;alert(1)&lt;/script&gt;") &&
    !html.includes("<script>alert(1)</script>")
)
check(
  "and carries no script of its own — a webview is pushed, not polled",
  !html.includes("setInterval")
)

console.log("\n# alignment")
check(
  "a centred paragraph is centred",
  html.includes('<p style="text-align:center">middle</p>'),
  html.match(/<p[^>]*>middle<\/p>/)?.[0]
)
check(
  "an alignment and a colour share the one attribute",
  html.includes(
    '<h3 class="tint" style="color:var(--hl-blue-text);text-align:right">'
  ),
  html.match(/<h3[^>]*>/)?.[0]
)
check(
  "the default is left unsaid rather than written onto every block",
  html.includes("<p>plain</p>"),
  html.match(/<p[^>]*>plain<\/p>/)?.[0]
)
check(
  "an alignment that is not one of the four is dropped, not spent as CSS",
  html.includes("<p>forged</p>") && !html.includes("color:red"),
  html.match(/<p[^>]*>forged<\/p>/)?.[0]
)
check(
  "a picture is aligned by the figure around it",
  html.includes('<figure style="text-align:center"><img'),
  html.match(/<figure[^>]*><img[^>]*wide[^>]*>/)?.[0]
)
check(
  "and a list nested in an aligned item does not inherit it",
  html.includes("li > ul, li > ol")
)
check(
  "an aligned list item is marked so its bullet travels with its words",
  html.includes('<li class="aligned" style="text-align:center">moved</li>') &&
    html.includes("li.aligned { list-style-position: inside; }"),
  html.match(/<li[^>]*>moved<\/li>/)?.[0]
)
check(
  "and an unaligned one beside it keeps the marker where it was",
  html.includes("<li>stayed</li>"),
  html.match(/<li[^>]*>stayed<\/li>/)?.[0]
)

console.log("\n# light and dark")
check(
  "a page with no opinion says so and leaves the surface to decide",
  html.includes('<html lang="en" data-theme="auto">') &&
    html.includes("color-scheme: light dark;"),
  html.match(/<html[^>]*>/)?.[0]
)
check(
  "and carries both palettes, so neither costs a second request",
  html.includes("--paper: #ffffff") && html.includes("--paper: #1f1f1f")
)
const dark = page("Spec", "v1", "<article></article>", "dark")
const light = page("Spec", "v1", "<article></article>", "light")
check(
  "a chosen theme is one attribute on the document",
  dark.includes('data-theme="dark"') && light.includes('data-theme="light"'),
  dark.match(/<html[^>]*>/)?.[0]
)
check(
  "chosen dark pins the browser's own controls to it too",
  dark.includes(':root[data-theme="dark"] { color-scheme: dark; }')
)
check(
  "chosen light outranks a reader whose OS is dark",
  dark.includes('@media (prefers-color-scheme: dark) {\n  :root:not([data-theme="light"])')
)
check(
  "and the webview follows the editor's theme by the class VS Code stamps",
  html.includes(':root:not([data-theme="light"]) body.vscode-dark')
)
check(
  "the dark palette is written once and emitted twice",
  html.split("--paper: #1f1f1f").length - 1 === 2
)
check(
  "a theme off the list is refused rather than spent as an attribute",
  page("Spec", "v1", "", "midnight" as never).includes('data-theme="auto"')
)
check(
  "and choosing one still needs no script in the page",
  !dark.includes("<script")
)

console.log("\n# an empty note")
check(
  "renders rather than throwing",
  page("New", "v1", renderNote(parseNote(""), new Map())).length > 0
)
check("and a half-written file does too", parseNote("[{").length === 0)

console.log(
  failures === 0
    ? `\n✓ all checks passed\n`
    : `\n✗ ${failures} check${failures === 1 ? "" : "s"} failed\n`
)
process.exit(failures === 0 ? 0 : 1)
