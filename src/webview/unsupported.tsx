import { createReactBlockSpec } from "@blocknote/react"

import { UNSUPPORTED_BLOCK } from "../note-schema"

/**
 * A block this build has no editor for, shown as the JSON it is.
 *
 * **Why a placeholder and not a refusal.** BlockNote looks a block's spec up by
 * its type and throws when there is none — `node type columnList not found in
 * schema`, during construction, during render, so React unmounts and the panel is
 * white. The first fix here was to check the document first and say which blocks;
 * that is honest and it is still the wrong answer, because a note is not one
 * block. `sample/spec.note` holds two `columnList` wrappers and nothing else in it
 * is unknown: the rest are ordinary headings, tables and lists somebody wants to
 * edit, and refusing the file holds all of them hostage to a wrapper.
 *
 * So the unknown ones are *folded* into this block on the way in and *unfolded*
 * back on the way out. The rest of the note is an ordinary document. What is on
 * screen where the block was is a fenced listing of it, which is the same answer
 * markdown gives for something it cannot express and the same one `note-html.ts`
 * gives in the preview.
 *
 * **It is read-only, and that is what makes the round trip safe.** The whole block
 * — its id, its props, its children, in their original key order — is carried in a
 * prop and written back byte for byte, so a note nobody touched produces the text
 * it came from and the tab does not go dirty for having been opened. Hand-editing
 * JSON inside a block editor could not offer that, and offering it would mean a
 * typo silently rewriting a block nothing here understands. It can be selected,
 * moved and deleted like any other block; to *change* one, use the notes MCP
 * server or the plain text editor.
 *
 * The two walks that fold and unfold are in `note-schema.ts` rather than here —
 * they are the part that could lose a block, and there they can be tested without
 * a DOM to mount.
 */

/** How much of the block to draw. The whole of it is in the prop either way —
 * this is a listing to recognise the block by, not the file. */
const SHOWN = 4_000

export const unsupportedBlockSpec = createReactBlockSpec(
  {
    type: UNSUPPORTED_BLOCK,
    // One thing, not a container: there is nothing in it to put a caret in, and a
    // selection must not reach inside. The same choice the drawing block makes.
    content: "none",
    propSchema: {
      /** The type this stands in for, which is the useful half of what to say. */
      blockType: { default: "" },
      /** The block itself, verbatim. `unfold` reads this and nothing else. */
      json: { default: "" },
    },
  },
  {
    render: ({ block }) => {
      const type = block.props.blockType || "unknown"
      const listing = pretty(block.props.json)

      return (
        <div className="note-unsupported" contentEditable={false}>
          <p className="note-unsupported-label">
            <code>{type}</code> — this build has no editor for this block. It is
            kept exactly as it is; you can move or delete it here, and change it
            with the notes MCP server or the plain text editor.
          </p>
          <pre>
            {listing.length > SHOWN
              ? `${listing.slice(0, SHOWN)}\n… ${listing.length - SHOWN} more characters`
              : listing}
          </pre>
        </div>
      )
    },
  }
)

/** The block, indented, for reading. Falls back to the string it was handed —
 * which is the whole point of never having parsed it to draw it. */
function pretty(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json), null, 2)
  } catch {
    return json
  }
}
