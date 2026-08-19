import type { NoteBlock } from "./protocol"

/**
 * Which blocks the editor in this extension can actually open — the one fact the
 * webview and the MCP server both need, and the second thing after `protocol.ts`
 * that crosses between sides.
 *
 * **Why this has to be shared.** A note is a file, so a note can hold a block
 * this build has no spec for: one written by a later version, by the desktop app,
 * or by an extension of BlockNote's this schema does not include. The editor's
 * answer to that is not graceful — `blockToNode` throws `node type columnList not
 * found in schema` while the editor is being constructed, which is during render,
 * so React unmounts and the panel is white. `main.tsx` now checks first and says
 * which blocks instead.
 *
 * That fixes it for a person looking at the panel. It fixes nothing for a program
 * writing the file, which is what `src/mcp/` is: without this list the server
 * would hand a model a note that reads perfectly and cannot be opened, and the
 * model would have no way to find that out. So the check lives here, where both
 * can reach it, and the tools report it.
 *
 * **This list is a copy, and the schema is the original.** The truth is
 * `Object.keys(schema.blockSchema)` in `editor.tsx` — BlockNote's own
 * `defaultBlockSpecs` plus this extension's `drawing` — and that is a browser
 * module the MCP server cannot import. So the webview passes the real schema in
 * and this list is only what the server falls back to; `editor.tsx` compares the
 * two on load and says so in the console when they have drifted apart.
 */
export const EDITOR_BLOCK_TYPES: readonly string[] = [
  // BlockNote's `defaultBlockSpecs`, as of 0.53.
  "audio",
  "bulletListItem",
  "checkListItem",
  "codeBlock",
  "divider",
  "file",
  "heading",
  "image",
  "numberedListItem",
  "paragraph",
  "quote",
  "table",
  "toggleListItem",
  "video",
  // This extension's own. See `webview/drawing-block.tsx`.
  "drawing",
  /* Tabs, which are a pair: `tabList` draws the strip and each `tab` under it
     carries one pane's blocks as its children. Neither is any use without the
     other, and a `tab` outside a `tabList` is drawn as ordinary blocks rather
     than hidden — see `webview/tabs-block.tsx`. */
  "tabList",
  "tab",
]

/**
 * The block types in this note that `known` does not know, each once, sorted.
 *
 * `known` is the schema when the webview asks and the list above when the server
 * does — the same walk either way, so the two sides cannot disagree about what
 * counts as a block or about looking inside `children`, which is where it matters:
 * a `columnList`'s text is all in its children, so the unknown type is the wrapper
 * and everything readable is underneath it.
 *
 * A block with no `type` is a paragraph, which is what BlockNote assumes for one.
 */
export function typesNotKnownBy(
  blocks: NoteBlock[],
  known: (type: string) => boolean = (type) => EDITOR_BLOCK_TYPES.includes(type)
): string[] {
  const found = new Set<string>()

  const walk = (nodes: NoteBlock[]): void => {
    for (const node of nodes) {
      if (!node) continue
      if (!known(node.type ?? "paragraph")) found.add(node.type ?? "paragraph")
      if (node.children?.length) walk(node.children)
    }
  }

  walk(blocks)
  return [...found].sort()
}

/**
 * The stand-in the editor draws where a block it has no spec for was.
 *
 * Not a type a note ever holds. It exists between `foldUnsupported` on the way
 * into the editor and `unfoldUnsupported` on the way out, and the pair of them is
 * what lets a note with one unknown wrapper in it be a note whose other seventy
 * blocks are editable. The React side of it is `webview/unsupported.tsx`; the two
 * walks are here because they are the part that can lose a block, and here they
 * can be tested without a DOM.
 */
export const UNSUPPORTED_BLOCK = "unsupportedBlock"

/**
 * The document with every block `known` does not know folded into a placeholder.
 *
 * The *outermost* unknown block, with its subtree inside it. A `columnList`'s
 * columns are unknown too and its paragraphs are not, but the three only mean
 * anything together: folding them separately would leave the paragraphs at the top
 * level of the note, which is a different document from the one on disk.
 *
 * The id is kept, so the block is still the same block to everything that names
 * one — the outline the MCP server prints, and an edit aimed at it.
 */
export function foldUnsupported(
  blocks: NoteBlock[],
  known: (type: string) => boolean = (type) => EDITOR_BLOCK_TYPES.includes(type)
): NoteBlock[] {
  return blocks.map((block) => {
    if (!known(block.type ?? "paragraph")) {
      return {
        id: block.id,
        type: UNSUPPORTED_BLOCK,
        props: {
          blockType: block.type ?? "paragraph",
          json: JSON.stringify(block),
        },
      }
    }

    if (!block.children?.length) return block
    return { ...block, children: foldUnsupported(block.children, known) }
  })
}

/**
 * The document as it was, every placeholder back to the block it stood for.
 *
 * `JSON.parse` of what `JSON.stringify` wrote, so the keys come back in the order
 * they went in and the text this produces for an untouched note is the text the
 * note already held — which is what keeps opening one out of the undo stack and
 * off the dirty dot. The placeholder is read-only in the editor for the same
 * reason: a typo in hand-edited JSON would be a block nothing here understands,
 * rewritten.
 */
export function unfoldUnsupported(blocks: NoteBlock[]): NoteBlock[] {
  return blocks.map((block) => {
    if (block.type === UNSUPPORTED_BLOCK) {
      const json = block.props?.json
      if (typeof json === "string" && json) {
        try {
          return JSON.parse(json) as NoteBlock
        } catch {
          // Unreachable while the placeholder is read-only, and too expensive to
          // be wrong about quietly: it is the only copy of the block.
          console.error("A folded block could not be restored", json)
        }
      }
      return block
    }

    if (!block.children?.length) return block
    return { ...block, children: unfoldUnsupported(block.children) }
  })
}
