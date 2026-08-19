import type { NoteBlock } from "../protocol"

/**
 * Reading a note's document on the host side.
 *
 * The webview has its own walks over the same blocks and neither imports the
 * other's, which is the rule the app this comes from is built on. What the host
 * needs is exactly two things: the parse, and the one rewrite the preview cannot
 * do without.
 */

/** The blocks in a note's file, or none for a file that is empty, half-written
 * or not an array. A preview is a read: it reports and shows an empty note rather
 * than refusing to answer. */
export function parseNote(text: string): NoteBlock[] {
  if (!text.trim()) return []
  try {
    const parsed: unknown = JSON.parse(text)
    return Array.isArray(parsed) ? (parsed as NoteBlock[]) : []
  } catch {
    console.error("Could not read the note's blocks")
    return []
  }
}

/** Every drawing the document points at, each once — a note can hold the same
 * drawing twice, and the picture behind it is read by id. */
export function drawingIdsIn(blocks: NoteBlock[]): string[] {
  const ids: string[] = []

  const walk = (nodes: NoteBlock[]): void => {
    for (const node of nodes) {
      if (node.type === "drawing") {
        const id = node.props?.drawingId
        const trimmed = typeof id === "string" ? id.trim() : ""
        if (trimmed && !ids.includes(trimmed)) ids.push(trimmed)
      }
      if (node.children) walk(node.children)
    }
  }

  walk(blocks)
  return ids
}

/**
 * The same document with every relative URL in it put through `resolve`.
 *
 * A picture in a note is stored as a path — into the workspace's assets
 * directory, or, for a note written before that existed, relative to the note
 * itself — which is what keeps the document portable and which nothing but this
 * extension can resolve. So it is resolved into the document before the walk that
 * renders it runs, rather than inside that walk: `note-html.ts` then keeps one
 * scheme list and sees a URL it can follow like any other, and it is the same
 * shape of substitution the app does for its `note-file://` scheme.
 *
 * `resolve` rather than a base string, because there are two bases now and which
 * one a path belongs to is the caller's question, not this walk's. The caller is
 * `preview.ts`, which has the workspace and can answer it.
 *
 * Left alone: anything with a scheme of its own — an image embedded from the web,
 * a `data:` URL pasted out of a browser — and anything that climbs, which is a
 * document asking for a file it has no business naming.
 */
export function withResolvedUrls(
  blocks: NoteBlock[],
  resolve: (path: string) => string
): NoteBlock[] {
  return blocks.map((block) => {
    const children = block.children
      ? withResolvedUrls(block.children, resolve)
      : block.children

    const url = block.props?.url
    if (!isRelative(url)) {
      return children === block.children ? block : { ...block, children }
    }
    return {
      ...block,
      props: { ...block.props, url: resolve(url) },
      ...(children ? { children } : {}),
    }
  })
}

/** Whether a URL is a path this extension stored. Parsed for a scheme rather than
 * pattern-matched for one, and `..` refused outright. */
function isRelative(url: unknown): url is string {
  if (typeof url !== "string" || !url || url.startsWith("/")) return false
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return false
  return !url.split("/").includes("..")
}
