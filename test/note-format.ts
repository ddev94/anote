import {
  blocksTextOf,
  documentTextOf,
  formatOf,
  rewrites,
} from "../src/host/note-format"
import type { NoteBlock } from "../src/protocol"

/**
 * The two files, and the conversion between them.
 *
 * What is worth testing here is not the markdown — `test/note-markdown.ts` does
 * that — but the decisions this module makes on the way to a `WorkspaceEdit`:
 * which file is which, that a `.note` is passed through untouched, that a `.md`
 * comes back as markdown, and above all that a message this side cannot read
 * writes *nothing*. Everything below is one keystroke away from overwriting
 * somebody's file.
 *
 * Plain asserts and a count, in the style of the tests beside it.
 */

let failures = 0

function check(what: string, ok: boolean, detail?: unknown) {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}`)
  if (!ok) {
    failures += 1
    if (detail !== undefined) console.log(`       ${String(detail)}`)
  }
}

const blocks = (...types: NoteBlock[]): string => JSON.stringify(types)

console.log("which file this is")
check("a note", formatOf("/notes/Spec.note") === "note")
check("a markdown file", formatOf("/notes/README.md") === "markdown")
check("whatever the case", formatOf("/notes/README.MD") === "markdown")
check(
  "a name that only contains .md is still a note",
  formatOf("/notes/.md.note") === "note"
)

console.log("a .note is passed through, both ways")
{
  const text = '[{"type":"paragraph","content":[]}]'
  check("the file's text reaches the webview unchanged", blocksTextOf(text, "note") === text)
  check("and the webview's document is written unchanged", documentTextOf(text, "note") === text)
  check(
    "even when it is not blocks at all — a half-written file is the editor's problem, not this one",
    documentTextOf("{ not json", "note") === "{ not json"
  )
}

console.log("a .md is converted, both ways")
{
  const markdown = "# Title\n\nA line with **bold** in it.\n"
  const asBlocks: NoteBlock[] = JSON.parse(blocksTextOf(markdown, "markdown"))
  check("it arrives as blocks", asBlocks[0]?.type === "heading", asBlocks[0]?.type)
  check("and there are two of them", asBlocks.length === 2, asBlocks.length)

  const back = documentTextOf(JSON.stringify(asBlocks), "markdown")
  check("and goes back as the same markdown", back === markdown, JSON.stringify(back))
}

console.log("an empty file is an empty document")
check("no blocks", blocksTextOf("", "markdown") === "[]")
check(
  "and an empty note writes an empty file",
  documentTextOf("[]", "markdown") === ""
)

console.log("a message this side cannot read writes nothing")
check("not json", documentTextOf("{ not json", "markdown") === null)
check("json that is not a list of blocks", documentTextOf('{"type":"paragraph"}', "markdown") === null)
check("a bare string", documentTextOf('"hello"', "markdown") === null)

console.log("the blocks markdown has no syntax for still survive a .md")
{
  const drawing = blocks({
    type: "drawing",
    props: { drawingId: "d1", url: "N.md.assets/d1.png" },
  })
  const written = documentTextOf(drawing, "markdown") ?? ""
  check("written as the comment that carries it", written.startsWith("<!-- note drawing "), written)
  const again: NoteBlock[] = JSON.parse(blocksTextOf(written, "markdown"))
  check("and read back as the block it was", again[0]?.type === "drawing", again[0]?.type)
  check(
    "with its props intact",
    (again[0]?.props as { drawingId?: string })?.drawingId === "d1"
  )
}

console.log("which markdown this editor would rewrite")
check("an empty file is not a rewrite", !rewrites("   \n"))
check("markdown it round-trips is not a rewrite", !rewrites("# Title\n\nA line.\n"))
check(
  "a file that differs only in trailing whitespace is not a rewrite",
  !rewrites("# Title  \n\nA line.\n\n\n")
)
check(
  "a hard-wrapped paragraph is — it comes back as one line",
  rewrites("A paragraph that somebody wrapped\nacross two lines by hand.\n")
)
check(
  "and so is a setext heading, which is read as the paragraph it looks like",
  rewrites("Title\n=====\n\nA line.\n")
)

console.log(failures === 0 ? "\nall ok" : `\n${failures} failed`)
if (failures > 0) process.exit(1)
