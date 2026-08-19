import type { NoteBlock, NoteFormat } from "../protocol"
import { blocksToMarkdown, markdownToBlocks } from "./note-markdown"

/**
 * Which of the two files a note is kept in, and the conversion between them.
 *
 * Here rather than in `note-editor.ts` for one reason: nothing in this file
 * imports `vscode`, so the thing that decides what gets written over somebody's
 * markdown can be run by a test. The editor is a webview inside an extension
 * host, which is the one part of this repository no test reaches, and "the blocks
 * are turned back into the file they came out of" is not a claim to leave
 * untested.
 *
 * The webview is on the other side of all of this and sees only blocks — see
 * `NoteFormat` in `protocol.ts`.
 */

/**
 * Which file this is.
 *
 * The extension rather than the view type it was opened with: one provider
 * answers for both registrations, and `.md` is the whole of the difference.
 */
export function formatOf(path: string): NoteFormat {
  return path.toLowerCase().endsWith(".md") ? "markdown" : "note"
}

/**
 * The file's text, as the blocks the webview is given.
 *
 * A `.note` already is them, and is handed over as it stands. A `.md` is read
 * into them here, so that markdown never crosses the boundary in `protocol.ts`.
 */
export function blocksTextOf(text: string, format: NoteFormat): string {
  if (format === "note") return text
  return JSON.stringify(markdownToBlocks(text))
}

/**
 * The blocks the webview sent, as the text the file holds — or null for a
 * message this side cannot read, which the caller refuses to write.
 *
 * The `.note` direction is the identity, and deliberately so: the document *is*
 * the blocks, and re-serialising them here would reformat a file for no reason
 * and lose whatever a hand edit had done to its whitespace.
 */
export function documentTextOf(
  blocks: string,
  format: NoteFormat
): string | null {
  if (format === "note") return blocks
  try {
    const parsed: unknown = JSON.parse(blocks)
    return Array.isArray(parsed) ? blocksToMarkdown(parsed as NoteBlock[]) : null
  } catch {
    return null
  }
}

/**
 * Whether opening this markdown as blocks and saving it would give a different
 * file back — which is worth saying out loud before the first keystroke does it.
 *
 * The round trip itself rather than a list of syntax to look for: whatever the
 * converters actually do is what the file will actually become. Trailing
 * whitespace is settled first, because a file that differs only in where its
 * last newline is is a file nobody needs a dialog about.
 *
 * False for anything that throws on the way: a conversion that fails is a bug,
 * not a rewrite, and `documentTextOf` refuses to write a document it cannot turn
 * back anyway.
 */
export function rewrites(markdown: string): boolean {
  if (!markdown.trim()) return false
  try {
    return settled(blocksToMarkdown(markdownToBlocks(markdown))) !== settled(markdown)
  } catch {
    return false
  }
}

/** A document with its trailing whitespace settled, for a comparison that is
 * about the writing rather than about the last newline. */
function settled(text: string): string {
  return text.replace(/[ \t]+$/gm, "").replace(/\n+$/, "\n")
}
