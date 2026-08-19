import { readFileSync } from "node:fs"

import {
  EDITOR_BLOCK_TYPES,
  foldUnsupported,
  typesNotKnownBy,
  unfoldUnsupported,
  UNSUPPORTED_BLOCK,
} from "../src/note-schema"
import type { NoteBlock } from "../src/protocol"

/**
 * Folding a block the editor cannot draw, and getting it back.
 *
 * The claim worth testing is one sentence: **a note nobody edited comes out of the
 * editor as the text it went in as.** Everything else here is in service of it,
 * because the failure mode is not a crash — it is a note whose `columnList` came
 * back subtly different, or came back not at all, on a save nobody thought was a
 * change. The walks live in `note-schema.ts` and not beside their React component
 * precisely so that this file can hold them to it with no DOM in sight.
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

/** What the editor knows, for the tests that want the real answer. */
const known = (type: string) => EDITOR_BLOCK_TYPES.includes(type)

const text = (value: string) => ({ type: "text", text: value, styles: {} })

/* The shape of `sample/spec.note`'s header: a wrapper the editor has no spec for,
   holding wrappers it also has none for, holding paragraphs it does. */
const COLUMNS: NoteBlock[] = [
  {
    id: "id-heading",
    type: "heading",
    props: { level: 1 },
    content: [text("Spec")],
  },
  {
    id: "id-cols",
    type: "columnList",
    props: {},
    children: [
      {
        id: "id-col-1",
        type: "column",
        props: { width: 1 },
        children: [
          { id: "id-a", type: "paragraph", props: {}, content: [text("left")] },
        ],
      },
      {
        id: "id-col-2",
        type: "column",
        props: { width: 1 },
        children: [
          { id: "id-b", type: "paragraph", props: {}, content: [text("right")] },
        ],
      },
    ],
  },
  {
    id: "id-tail",
    type: "paragraph",
    props: {},
    content: [text("after")],
  },
]

console.log("folding")

{
  const folded = foldUnsupported(COLUMNS, known)

  check(
    "the blocks the editor knows are left exactly as they were",
    folded[0] === COLUMNS[0] && folded[2] === COLUMNS[2]
  )
  check(
    "the unknown one became the placeholder",
    folded[1]?.type === UNSUPPORTED_BLOCK,
    folded[1]?.type
  )
  check("and kept its id", folded[1]?.id === "id-cols")
  check(
    "the placeholder says which type it stands for",
    folded[1]?.props?.blockType === "columnList",
    JSON.stringify(folded[1]?.props?.blockType)
  )
  check(
    "the whole subtree came with it",
    String(folded[1]?.props?.json).includes("id-b"),
    String(folded[1]?.props?.json).slice(0, 120)
  )
  check(
    "and nothing was left behind at the top level",
    folded.length === COLUMNS.length && !folded[1]?.children,
    folded.length
  )
  check(
    "the folded document has nothing the editor cannot draw",
    typesNotKnownBy(folded, (type) => type === UNSUPPORTED_BLOCK || known(type))
      .length === 0
  )
}

console.log("unfolding")

{
  const back = unfoldUnsupported(foldUnsupported(COLUMNS, known))
  check(
    "out and back is the same document, to the byte",
    JSON.stringify(back) === JSON.stringify(COLUMNS),
    JSON.stringify(back)
  )
  check("which means the same key order too", JSON.stringify(back[1]) === JSON.stringify(COLUMNS[1]))
}

{
  // The one that matters most: the real file, which is where an assumption about
  // shape would show up.
  const spec = JSON.parse(
    readFileSync("sample/spec.note", "utf8")
  ) as NoteBlock[]
  const source = JSON.stringify(spec)
  const back = JSON.stringify(unfoldUnsupported(foldUnsupported(spec, known)))

  check("sample/spec.note survives the round trip unchanged", back === source)
  check(
    "and it really does hold blocks that had to be folded",
    typesNotKnownBy(spec).length > 0,
    typesNotKnownBy(spec).join(", ")
  )
}

console.log("nesting, and the edges")

{
  /* An unknown block under a known one — a list item with a wrapper inside it.
     The fold has to recurse, and the unfold has to come back down the same path. */
  const nested: NoteBlock[] = [
    {
      id: "id-item",
      type: "bulletListItem",
      props: {},
      content: [text("one")],
      children: [{ id: "id-odd", type: "somethingLater", props: { a: 1 } }],
    },
  ]

  const folded = foldUnsupported(nested, known)
  check(
    "an unknown block nested under a known one is folded in place",
    folded[0]?.children?.[0]?.type === UNSUPPORTED_BLOCK,
    JSON.stringify(folded[0]?.children?.[0])
  )
  check(
    "and comes back where it was",
    JSON.stringify(unfoldUnsupported(folded)) === JSON.stringify(nested)
  )
}

check(
  "an empty document folds to an empty document",
  foldUnsupported([], known).length === 0 && unfoldUnsupported([]).length === 0
)

check(
  "a note with nothing to fold is returned untouched",
  (() => {
    const plain: NoteBlock[] = [
      { id: "a", type: "paragraph", props: {}, content: [text("hi")] },
    ]
    return foldUnsupported(plain, known)[0] === plain[0]
  })()
)

check(
  "a block with no type at all is a paragraph, not an unknown",
  foldUnsupported([{ id: "a", content: [] }], known)[0]?.type !== UNSUPPORTED_BLOCK
)

check(
  "a placeholder whose json cannot be read is kept rather than dropped",
  (() => {
    const broken: NoteBlock[] = [
      {
        id: "a",
        type: UNSUPPORTED_BLOCK,
        props: { blockType: "columnList", json: "{ not json" },
      },
    ]
    const back = unfoldUnsupported(broken)
    return back.length === 1 && back[0]?.type === UNSUPPORTED_BLOCK
  })()
)

console.log("the list the MCP server writes from")

check(
  "every type the list names is a real BlockNote default or this build's own",
  EDITOR_BLOCK_TYPES.length === 17 &&
    EDITOR_BLOCK_TYPES.includes("drawing") &&
    EDITOR_BLOCK_TYPES.includes("tabList") &&
    EDITOR_BLOCK_TYPES.includes("tab"),
  EDITOR_BLOCK_TYPES.join(", ")
)
check(
  "the placeholder is not on it — it is not a block a note may hold",
  !EDITOR_BLOCK_TYPES.includes(UNSUPPORTED_BLOCK)
)
check(
  "typesNotKnownBy looks inside children",
  JSON.stringify(typesNotKnownBy(COLUMNS)) === JSON.stringify(["column", "columnList"]),
  typesNotKnownBy(COLUMNS).join(", ")
)

console.log(failures === 0 ? "\nall ok" : `\n${failures} failed`)
if (failures > 0) process.exit(1)
