import {
  blocksToMarkdown,
  markdownToBlocks,
  outlineOf,
  whatMarkdownDrops,
} from "../src/host/note-markdown"
import type { NoteBlock } from "../src/protocol"

/**
 * Markdown, both ways.
 *
 * The claim worth testing is the round trip, not the prettiness: a note read as
 * markdown, written back, and read again has to be the same note. That is what
 * `src/mcp/` sells — a model edits a sentence and everything it did not touch
 * survives — so nearly every check here is "out and back", with the shape of the
 * markdown checked only where the shape is the point.
 *
 * Plain asserts and a count, in the style of `test/preview.ts` beside it.
 */

let failures = 0

function check(what: string, ok: boolean, detail?: unknown) {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}`)
  if (!ok) {
    failures += 1
    if (detail !== undefined) console.log(`       ${String(detail)}`)
  }
}

/** The blocks, with the ids taken off — a round trip mints new ones, and it is
 * everything else that has to come back. */
function shape(blocks: NoteBlock[]): unknown {
  return blocks.map((block) => ({
    type: block.type,
    props: block.props,
    content: block.content ?? null,
    children: block.children ? shape(block.children) : undefined,
  }))
}

function roundTrip(what: string, blocks: NoteBlock[]) {
  const markdown = blocksToMarkdown(blocks)
  const back = markdownToBlocks(markdown)
  const same = JSON.stringify(shape(blocks)) === JSON.stringify(shape(back))
  check(
    what,
    same,
    same ? undefined : `${markdown}\n  ---\n  ${JSON.stringify(shape(back))}`
  )
}

const text = (value: string, styles: Record<string, boolean> = {}) => ({
  type: "text",
  text: value,
  styles,
})

const TEXT_PROPS = {
  backgroundColor: "default",
  textColor: "default",
  textAlignment: "left",
}

const paragraph = (...content: unknown[]): NoteBlock => ({
  type: "paragraph",
  props: { ...TEXT_PROPS },
  content,
})

console.log("markdown, out and back")

roundTrip("a paragraph", [paragraph(text("Just some words."))])

roundTrip("the emphasis marks", [
  paragraph(
    text("plain "),
    text("bold", { bold: true }),
    text(" "),
    text("italic", { italic: true }),
    text(" "),
    text("struck", { strike: true }),
    text(" "),
    text("code()", { code: true })
  ),
])

roundTrip("emphasis inside emphasis", [
  paragraph(text("both", { bold: true, italic: true })),
])

roundTrip("a link", [
  paragraph(text("See "), {
    type: "link",
    href: "https://example.test/a(b)",
    content: [text("the docs")],
  }),
])

roundTrip("headings, every level", [
  { type: "heading", props: { ...TEXT_PROPS, level: 1, isToggleable: false }, content: [text("One")] },
  { type: "heading", props: { ...TEXT_PROPS, level: 3, isToggleable: false }, content: [text("Three")] },
])

roundTrip("a quote", [
  {
    type: "quote",
    props: { backgroundColor: "default", textColor: "default" },
    content: [text("Said so.")],
  },
])

roundTrip("a divider", [{ type: "divider", props: {}, content: [] }])

roundTrip("a code block", [
  {
    type: "codeBlock",
    props: { language: "ts" },
    content: [text("const a = `x`\nif (a) return")],
  },
])

roundTrip("the three kinds of list", [
  { type: "bulletListItem", props: { ...TEXT_PROPS }, content: [text("one")] },
  { type: "bulletListItem", props: { ...TEXT_PROPS }, content: [text("two")] },
  { type: "numberedListItem", props: { ...TEXT_PROPS }, content: [text("first")] },
  { type: "numberedListItem", props: { ...TEXT_PROPS }, content: [text("second")] },
  { type: "checkListItem", props: { ...TEXT_PROPS, checked: true }, content: [text("done")] },
  { type: "checkListItem", props: { ...TEXT_PROPS, checked: false }, content: [text("not")] },
])

roundTrip("a numbered list that does not start at one", [
  { type: "numberedListItem", props: { ...TEXT_PROPS, start: 4 }, content: [text("four")] },
  { type: "numberedListItem", props: { ...TEXT_PROPS }, content: [text("five")] },
])

roundTrip("a list inside a list", [
  {
    type: "bulletListItem",
    props: { ...TEXT_PROPS },
    content: [text("outer")],
    children: [
      { type: "bulletListItem", props: { ...TEXT_PROPS }, content: [text("inner")] },
      {
        type: "bulletListItem",
        props: { ...TEXT_PROPS },
        content: [text("inner two")],
        children: [
          { type: "bulletListItem", props: { ...TEXT_PROPS }, content: [text("deeper")] },
        ],
      },
    ],
  },
  { type: "bulletListItem", props: { ...TEXT_PROPS }, content: [text("next")] },
])

roundTrip("a paragraph under a bullet", [
  {
    type: "bulletListItem",
    props: { ...TEXT_PROPS },
    content: [text("the point")],
    children: [paragraph(text("and the reason for it"))],
  },
])

roundTrip("an image", [
  {
    type: "image",
    props: { name: "", url: "Notes.note.assets/a.png", caption: "A shape" },
    content: null,
  },
])

roundTrip("a table", [
  {
    type: "table",
    props: {},
    content: {
      type: "tableContent",
      headerRows: 1,
      rows: [
        {
          cells: [
            { type: "tableCell", content: [text("Name")], props: { colspan: 1, rowspan: 1 } },
            { type: "tableCell", content: [text("Why")], props: { colspan: 1, rowspan: 1 } },
          ],
        },
        {
          cells: [
            { type: "tableCell", content: [text("a | b")], props: { colspan: 1, rowspan: 1 } },
            { type: "tableCell", content: [text("piped")], props: { colspan: 1, rowspan: 1 } },
          ],
        },
      ],
    },
  },
])

roundTrip("a table with no header row", [
  {
    type: "table",
    props: {},
    content: {
      type: "tableContent",
      headerRows: 0,
      rows: [
        {
          cells: [
            { type: "tableCell", content: [text("one")], props: { colspan: 1, rowspan: 1 } },
            { type: "tableCell", content: [text("two")], props: { colspan: 1, rowspan: 1 } },
          ],
        },
      ],
    },
  },
])

/*
 * The blocks markdown has no syntax for. These are the ones a round trip would
 * silently delete if they were not carried, which is the whole reason the
 * comment marker exists.
 */
roundTrip("a video", [
  {
    type: "video",
    props: {
      backgroundColor: "default",
      name: "Screen Recording.mov",
      url: "Notes.note.assets/1.mov",
      caption: "",
      showPreview: true,
    },
    content: null,
  },
])

roundTrip("a drawing", [
  {
    type: "drawing",
    props: { drawingId: "5b2a9bce-4522-4d79-a475-3fc9d25dce20" },
    content: null,
  },
])

roundTrip("a block this build has never heard of", [
  { type: "somethingLater", props: { mode: "wide" }, content: [text("words")] },
])

roundTrip("an audio clip whose name could close the comment", [
  {
    type: "audio",
    props: { name: "a --> b.mp3", url: "Notes.note.assets/2.mp3", caption: "" },
    content: null,
  },
])

console.log("what the syntax would otherwise eat")

check(
  "text that looks like markdown comes back as text",
  (() => {
    const blocks = [paragraph(text("2 * 3 * 4 and a_b_c and [not] a link"))]
    const back = markdownToBlocks(blocksToMarkdown(blocks))
    return JSON.stringify(shape(blocks)) === JSON.stringify(shape(back))
  })(),
  blocksToMarkdown([paragraph(text("2 * 3 * 4 and a_b_c and [not] a link"))])
)

check(
  "a paragraph that starts like a list stays a paragraph",
  (() => {
    const back = markdownToBlocks(blocksToMarkdown([paragraph(text("- not a bullet"))]))
    return back[0]?.type === "paragraph"
  })()
)

check(
  "a sentence beginning with a number stays a paragraph",
  markdownToBlocks(blocksToMarkdown([paragraph(text("1. of several reasons"))]))[0]
    ?.type === "paragraph"
)

console.log("reading markdown somebody wrote by hand")

{
  const blocks = markdownToBlocks(
    [
      "# Title",
      "",
      "Some **bold** text with `code` in it.",
      "",
      "* one",
      "* two",
      "  * nested",
      "",
      "1) first",
      "2) second",
      "",
      "> quoted",
      "",
      "```js",
      "const x = 1",
      "```",
      "",
      "| a | b |",
      "| --- | --- |",
      "| 1 | 2 |",
    ].join("\n")
  )

  const types = blocks.map((block) => block.type)
  check(
    "every construct became its own block",
    JSON.stringify(types) ===
      JSON.stringify([
        "heading",
        "paragraph",
        "bulletListItem",
        "bulletListItem",
        "numberedListItem",
        "numberedListItem",
        "quote",
        "codeBlock",
        "table",
      ]),
    types.join(", ")
  )
  check(
    "the nested bullet went under the item above it",
    blocks[3]?.children?.length === 1,
    JSON.stringify(blocks[3])
  )
  check("every block has an id", blocks.every((block) => Boolean(block.id)))
}

check(
  "a wrapped sentence is one paragraph",
  (() => {
    const blocks = markdownToBlocks("one line\nand its continuation")
    return (
      blocks.length === 1 &&
      JSON.stringify(blocks[0]?.content) ===
        JSON.stringify([text("one line and its continuation")])
    )
  })()
)

check("an empty document is no blocks", markdownToBlocks("").length === 0)
check("an empty note is an empty string", blocksToMarkdown([]) === "")

console.log("what it says it is losing")

{
  const drops = whatMarkdownDrops([
    {
      type: "paragraph",
      props: { ...TEXT_PROPS, textAlignment: "center" },
      content: [text("middle", { underline: true })],
    },
    { type: "image", props: { url: "a.png", previewWidth: 475 }, content: null },
  ])
  check(
    "alignment, underline and a display width are all named",
    drops.length === 3 &&
      drops.includes("alignment") &&
      drops.includes("underline") &&
      drops.includes("image display widths"),
    drops.join(", ")
  )
  check(
    "a note markdown holds whole loses nothing",
    whatMarkdownDrops([paragraph(text("plain"))]).length === 0
  )
  check(
    "a video is not a loss — it is carried",
    whatMarkdownDrops([
      { type: "video", props: { url: "a.mov" }, content: null },
    ]).length === 0
  )
}

console.log("the outline")

{
  const outline = outlineOf([
    {
      id: "aaaa",
      type: "heading",
      props: { level: 1 },
      content: [text("A note is a file")],
    },
    {
      id: "bbbb",
      type: "bulletListItem",
      props: {},
      content: [text("one")],
      children: [
        { id: "cccc", type: "paragraph", props: {}, content: [text("under it")] },
      ],
    },
  ])
  check(
    "every block is one line, id first",
    outline.split("\n").length === 3 &&
      outline.startsWith("aaaa  heading  A note is a file"),
    outline
  )
  check("a child is indented", outline.includes("\n  cccc  paragraph"), outline)
}

console.log(failures === 0 ? "\nall ok" : `\n${failures} failed`)
if (failures > 0) process.exit(1)
