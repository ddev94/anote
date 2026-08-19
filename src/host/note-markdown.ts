import { randomUUID } from "node:crypto"

import type { NoteBlock } from "../protocol"

/**
 * A note as markdown, and markdown as a note — both directions, in Node, with
 * nothing mounted.
 *
 * This exists for the same reason `note-html.ts` does, and it is the same answer.
 * BlockNote can do both of these (`blocksToMarkdownLossy`, `tryParseMarkdownToBlocks`)
 * and neither is available here: they are methods on an editor, an editor is
 * ProseMirror, and ProseMirror is a DOM. The preview paid that price by
 * hand-writing the walk to HTML; this pays it once more, and what it buys is
 * bigger than an export command — a note becomes something a program with no
 * VS Code in it can read and write. That is what `src/mcp/` is.
 *
 * **The round trip is the design constraint.** Read a note as markdown, change a
 * sentence, write it back, and everything the sentence was not must survive. So
 * the blocks markdown has no syntax for — a video, an audio clip, an attachment,
 * a drawing, a block from some later version of the editor — are not dropped and
 * are not invented a syntax for either. They are written as an HTML comment
 * carrying the block itself:
 *
 * ```
 * <!-- note video {"props":{"name":"demo.mov","url":"Notes.note.assets/….mov"}} -->
 * ```
 *
 * Invisible wherever markdown is rendered, obvious to anything editing the text,
 * and exact on the way back. A reader that deletes one has deleted a video, which
 * is the point: the loss is a decision rather than an accident.
 *
 * What markdown genuinely cannot carry is listed by `whatMarkdownDrops` — colours,
 * alignment, underline, merged table cells — and the caller is expected to say so
 * out loud before overwriting a note with a document that would lose them.
 */

/** The heading levels markdown has, which is also HTML's. */
const MAX_HEADING = 6

/**
 * A block markdown has no syntax for, carried whole.
 *
 * `>` is spent as `\u003e` inside the JSON so that no URL, name or caption can
 * close the comment early — the one thing that would turn a note's own text into
 * markup. It is still valid JSON, so the parse on the way back needs no undoing.
 */
const MARKER = /^<!-- note ([a-zA-Z][\w-]*) (\{[\s\S]*\}) -->$/

/** The inline styles, innermost first, so `**a**` never comes out as `*​*a*​*`. */
const EMPHASIS: [string, string][] = [
  ["**", "bold"],
  ["__", "bold"],
  ["~~", "strike"],
  ["*", "italic"],
  ["_", "italic"],
]

/** Which list a block belongs to, or null. The same grouping `note-html.ts`
 * does, for the same reason: the document has no list node, only items that
 * happen to follow one another. */
type ListKind = "bullet" | "ordered" | "check"

function listKindOf(block: NoteBlock): ListKind | null {
  switch (block.type) {
    case "bulletListItem":
      return "bullet"
    case "numberedListItem":
      return "ordered"
    case "checkListItem":
      return "check"
    // No marker of its own in markdown. It comes back a bullet, which
    // `whatMarkdownDrops` says out loud.
    case "toggleListItem":
      return "bullet"
    default:
      return null
  }
}

/* ------------------------------------------------------------------ blocks → */

/** The note as markdown, ending in one newline. An empty note is an empty
 * string, not a blank line. */
export function blocksToMarkdown(blocks: NoteBlock[]): string {
  const chunks = chunksOf(blocks)
  return chunks.length ? `${chunks.join("\n\n")}\n` : ""
}

/**
 * A run of blocks, as the paragraphs of markdown they become.
 *
 * Consecutive list items are gathered into one chunk so that a five-item list is
 * one list rather than five — the same pass `renderBlocks` makes in the preview,
 * and the same reason.
 */
function chunksOf(blocks: NoteBlock[]): string[] {
  const chunks: string[] = []

  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index]
    if (!block) continue

    /* A tab group, numbered. Its tabs are chunked here rather than left to the
       walk below because an untitled tab is named by where it sits — "Tab 3" —
       and `chunkOf` sees one block at a time, so this is the only place that
       knows which one it is. Anything else somebody indented into a group is
       left to the ordinary path. */
    if (block.type === "tabList") {
      for (const [at, child] of (block.children ?? []).entries()) {
        if (child?.type !== "tab") continue
        chunks.push(`### ${guardStart(tabTitle(child, at))}`)
        if (child.children?.length) chunks.push(...chunksOf(child.children))
      }
      const rest = (block.children ?? []).filter((child) => child?.type !== "tab")
      if (rest.length) chunks.push(...chunksOf(rest))
      continue
    }

    const kind = listKindOf(block)
    if (!kind) {
      const chunk = chunkOf(block)
      if (chunk) chunks.push(chunk)
      // Un-nested, after the block, exactly as the preview does it: markdown has
      // no "paragraph with paragraphs under it" either.
      if (block.children?.length) chunks.push(...chunksOf(block.children))
      continue
    }

    const items: NoteBlock[] = []
    for (let scan = index; scan < blocks.length; scan++) {
      const candidate = blocks[scan]
      if (!candidate || listKindOf(candidate) !== kind) break
      items.push(candidate)
      index = scan
    }

    const start = kind === "ordered" ? (numberProp(items[0], "start") ?? 1) : 1
    chunks.push(
      items.map((item, at) => listItem(item, kind, start + at)).join("\n")
    )
  }

  return chunks
}

/** One list item, with everything under it indented to line up with its text —
 * which is what makes a nested list nested rather than a new list. */
function listItem(block: NoteBlock, kind: ListKind, number: number): string {
  const marker =
    kind === "ordered"
      ? `${number}. `
      : kind === "check"
        ? `- [${block.props?.checked === true ? "x" : " "}] `
        : "- "

  const lines = [marker + guardStart(inlineOf(block.content))]
  if (block.children?.length) {
    const indent = " ".repeat(marker.length)
    for (const chunk of chunksOf(block.children)) {
      lines.push("", indentBy(chunk, indent))
    }
  }
  return lines.join("\n")
}

function indentBy(chunk: string, indent: string): string {
  return chunk
    .split("\n")
    .map((line) => (line ? indent + line : line))
    .join("\n")
}

function chunkOf(block: NoteBlock): string {
  switch (block.type) {
    case "paragraph":
      return guardStart(inlineOf(block.content))

    case "heading": {
      const level = Math.min(Math.max(numberProp(block, "level") ?? 1, 1), MAX_HEADING)
      return `${"#".repeat(level)} ${guardStart(inlineOf(block.content))}`
    }

    case "quote":
      // One block, one line: a note's quote holds inline content, never blocks,
      // so there is nothing here to break across `>` lines.
      return `> ${guardStart(inlineOf(block.content))}`

    case "divider":
      return "---"

    case "codeBlock":
      return codeChunk(block)

    case "table":
      return tableChunk(block)

    /* A tab group has no line of its own: it is a wrapper, and the tabs under it
       are chunked next by `chunksOf`, exactly as any other block's children are. */
    case "tabList":
      return ""

    /* Markdown has no tabs, so a tab becomes the heading that reads most like one
       and its blocks follow underneath — which is what `chunksOf` does with any
       block's children already. Level 3 because a tab group sits inside a document
       with headings of its own, and an `h3` is the least surprising of the six to
       find a pane's worth of content under.

       This is the loss `whatMarkdownDrops` names: exported and read back, a group
       of three tabs is three headings and the group itself is gone. Toggle lists
       make the same trade, for the same reason. */
    case "tab":
      return `### ${guardStart(tabTitle(block, 0))}`

    case "image": {
      const url = stringProp(block, "url")
      // A picture with no file yet is a block somebody inserted and never
      // filled; `![](…)` with nothing in the parentheses is not a picture at
      // all, so it rides in a comment like the blocks that have no syntax.
      if (!url) return carried(block)
      return `![${escapeInline(stringProp(block, "caption"))}](${link(url)})`
    }

    default:
      return carried(block)
  }
}

/** A tab with no name of its own is named by where it sits, as it is on the
 * strip in the editor and on the one in the preview. */
function tabTitle(block: NoteBlock, at: number): string {
  return stringProp(block, "title").trim() || `Tab ${at + 1}`
}

/** A fence long enough that nothing in the code can end it early. */
function codeChunk(block: NoteBlock): string {
  const body = plainTextOf(block.content)
  const longest = [...body.matchAll(/`+/g)].reduce(
    (most, run) => Math.max(most, run[0].length),
    0
  )
  const fence = "`".repeat(Math.max(3, longest + 1))
  const language = stringProp(block, "language")
  return `${fence}${/^[a-z0-9+#_-]{1,24}$/i.test(language) ? language : ""}\n${body}\n${fence}`
}

/**
 * A table, as GFM's pipes.
 *
 * GFM has exactly one header row and requires the delimiter under it, so a note's
 * `headerRows` is spent as "the first row, or none": with none, the header comes
 * out empty and reads back as `headerRows: 0`. Merged cells, column widths and
 * per-cell colours have no pipes to live in — see `whatMarkdownDrops`.
 */
function tableChunk(block: NoteBlock): string {
  const content = block.content as
    | { rows?: { cells?: unknown }[]; headerRows?: number }
    | undefined
  const rows = Array.isArray(content?.rows) ? content.rows : []
  if (rows.length === 0) return ""

  const cellsOf = (row: { cells?: unknown }): unknown[] =>
    Array.isArray(row.cells) ? row.cells : []
  const width = rows.reduce((most, row) => Math.max(most, cellsOf(row).length), 0)
  if (width === 0) return ""

  const header = (content?.headerRows ?? 0) > 0
  const line = (cells: unknown[]): string => {
    const filled = Array.from({ length: width }, (_, at) => cellText(cells[at]))
    return `| ${filled.join(" | ")} |`
  }

  return [
    line(header ? cellsOf(rows[0] ?? { cells: [] }) : []),
    `| ${Array.from({ length: width }, () => "---").join(" | ")} |`,
    ...rows.slice(header ? 1 : 0).map((row) => line(cellsOf(row))),
  ].join("\n")
}

/** One cell's text. A cell is either BlockNote's object or the inline content on
 * its own — both shapes turn up in a note, as the preview also has to know. */
function cellText(raw: unknown): string {
  const content =
    typeof raw === "object" && raw !== null && "type" in raw
      ? (raw as { content?: unknown }).content
      : raw
  // A row is a line, so a newline inside a cell cannot survive as one.
  return inlineOf(content, true).replace(/\n/g, " ")
}

/** A block markdown has no syntax for, as the comment that carries it back. */
function carried(block: NoteBlock): string {
  const inside: Record<string, unknown> = {}
  if (block.props && Object.keys(block.props).length) inside.props = block.props
  if (block.content !== undefined && block.content !== null)
    inside.content = block.content

  const json = JSON.stringify(inside).replace(/>/g, "\\u003e")
  return `<!-- note ${block.type ?? "block"} ${json} -->`
}

/* ---------------------------------------------------------------- inline → */

/**
 * A block's inline content, as markdown.
 *
 * Styles are applied innermost-first — code, then strike, italic, bold — which is
 * the order that survives being read back: markdown inside a code span is text,
 * so a bold code run has to be `**\`x\`**` and never `\`**x**\``.
 */
function inlineOf(content: unknown, inTable = false): string {
  if (typeof content === "string") return escapeInline(content, inTable)
  if (!Array.isArray(content)) return ""

  return content
    .map((raw: unknown) => {
      if (typeof raw === "string") return escapeInline(raw, inTable)
      if (typeof raw !== "object" || raw === null) return ""
      const item = raw as Record<string, unknown>

      if (item.type === "link") {
        const inner = inlineOf(item.content, inTable)
        const href = typeof item.href === "string" ? item.href : ""
        // A link with nowhere to go keeps its words, as the preview does.
        return href ? `[${inner}](${link(href)})` : inner
      }

      const text = typeof item.text === "string" ? item.text : ""
      if (!text) return ""
      const styles = (item.styles ?? {}) as Record<string, unknown>

      if (styles.code) {
        const longest = [...text.matchAll(/`+/g)].reduce(
          (most, run) => Math.max(most, run[0].length),
          0
        )
        const fence = "`".repeat(longest + 1)
        // A code span may not begin or end with a backtick without a space.
        const pad = text.startsWith("`") || text.endsWith("`") ? " " : ""
        return wrap(`${fence}${pad}${text}${pad}${fence}`, styles)
      }
      return wrap(escapeInline(text, inTable), styles)
    })
    .join("")
}

function wrap(markdown: string, styles: Record<string, unknown>): string {
  let out = markdown
  if (styles.strike) out = `~~${out}~~`
  if (styles.italic) out = `_${out}_`
  if (styles.bold) out = `**${out}**`
  return out
}

/**
 * The characters that would otherwise be read as syntax.
 *
 * Deliberately short. Escaping every character markdown has ever given a meaning
 * to produces text nobody — and no model reading a note — wants to look at, so
 * what is escaped is what actually changes the parse *mid-line*: the emphasis
 * runs, code spans, link brackets and the backslash itself. Everything that only
 * means something at the start of a line is handled there instead, by
 * `guardStart`.
 */
function escapeInline(text: string, inTable = false): string {
  const escaped = text.replace(/([\\`*_[\]~])/g, "\\$1").replace(/!(?=\[)/g, "\\!")
  return inTable ? escaped.replace(/\|/g, "\\|") : escaped
}

/** A line that would otherwise open a block of its own — a sentence beginning
 * "1. " is a numbered list, and "- so it is" is a bullet. */
function guardStart(line: string): string {
  return line.replace(/^(\s*)(#{1,6} |>|[-+*] |\d{1,9}[.)] |\||---)/, "$1\\$2")
}

/** A URL fit to sit between the parentheses. Angle brackets are markdown's own
 * answer to a URL with a space in it, which is what a dropped file's name
 * routinely has. */
function link(url: string): string {
  return /[\s()<>]/.test(url) ? `<${url.replace(/[<>]/g, "")}>` : url
}

/* --------------------------------------------------------------- reading → */

/** The plain text of a block's content, for the places markup cannot go — a code
 * block's body, an outline's preview. */
export function plainTextOf(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((raw: unknown) => {
      if (typeof raw === "string") return raw
      if (typeof raw !== "object" || raw === null) return ""
      const item = raw as Record<string, unknown>
      if (typeof item.text === "string") return item.text
      return plainTextOf(item.content)
    })
    .join("")
}

/**
 * The note as a list of its blocks — id, type, and the first of the words.
 *
 * The cheap read. Markdown is what a note is *for* and it costs the whole note to
 * look at; this is what an edit is addressed *by*, and it fits in a glance. The
 * id is spelled out in full because that is what `edit_note` takes.
 */
export function outlineOf(blocks: NoteBlock[], depth = 0): string {
  const lines: string[] = []

  for (const block of blocks) {
    if (!block) continue
    const preview = plainTextOf(block.content).replace(/\s+/g, " ").trim()
    const extra =
      block.type === "drawing" || block.type === "image" || block.type === "video"
        ? stringProp(block, "name") || stringProp(block, "drawingId")
        : ""
    lines.push(
      `${"  ".repeat(depth)}${block.id ?? "(no id)"}  ${block.type ?? "block"}` +
        `${preview || extra ? `  ${cut(preview || extra, 72)}` : ""}`
    )
    if (block.children?.length) lines.push(outlineOf(block.children, depth + 1))
  }

  return lines.filter(Boolean).join("\n")
}

function cut(text: string, at: number): string {
  return text.length > at ? `${text.slice(0, at - 1)}…` : text
}

/**
 * What this note would lose on the way through markdown, in the words to say it
 * in — empty for a note markdown holds whole.
 *
 * The reason it exists: a tool that reads a note as markdown and writes markdown
 * back is a tool that can quietly delete a decision somebody made, and the only
 * honest thing to do about that is to say which decisions before doing it. The
 * blocks with no markdown syntax are *not* in here — they ride in comments and
 * come back exactly.
 */
export function whatMarkdownDrops(blocks: NoteBlock[]): string[] {
  const found = new Set<string>()

  const walk = (nodes: NoteBlock[]): void => {
    for (const node of nodes) {
      if (!node) continue
      const props = node.props ?? {}

      if (typeof props.textColor === "string" && props.textColor !== "default")
        found.add("text colours")
      if (
        typeof props.backgroundColor === "string" &&
        props.backgroundColor !== "default"
      )
        found.add("background colours")
      if (
        typeof props.textAlignment === "string" &&
        props.textAlignment !== "left"
      )
        found.add("alignment")
      if (node.type === "toggleListItem")
        found.add("toggle lists (they come back as bullets)")
      if (node.type === "tabList")
        found.add("tabs (each tab comes back as a heading)")
      if (node.type === "image" && typeof props.previewWidth === "number")
        found.add("image display widths")
      if (node.type === "table") tableLoss(node, found)

      for (const run of Array.isArray(node.content) ? node.content : []) {
        const styles =
          typeof run === "object" && run !== null
            ? ((run as { styles?: Record<string, unknown> }).styles ?? {})
            : {}
        if (styles.underline) found.add("underline")
        if (styles.textColor || styles.backgroundColor)
          found.add("text colours")
      }

      if (node.children?.length) {
        /* A tab group's nesting is not lost, it is spent: the tabs become
           headings and their blocks sit under them, which is what markdown does
           with a heading anyway. Saying it was flattened as well would be a
           second warning about the line above. */
        if (!listKindOf(node) && node.type !== "tabList" && node.type !== "tab")
          found.add("blocks nested under a paragraph or heading (flattened)")
        walk(node.children)
      }
    }
  }

  walk(blocks)
  return [...found]
}

function tableLoss(block: NoteBlock, found: Set<string>): void {
  const content = block.content as
    | { rows?: { cells?: unknown }[]; headerRows?: number; columnWidths?: unknown }
    | undefined
  if (Array.isArray(content?.columnWidths) && content.columnWidths.some(Boolean))
    found.add("table column widths")
  if ((content?.headerRows ?? 0) > 1) found.add("tables with several header rows")

  for (const row of content?.rows ?? []) {
    for (const raw of Array.isArray(row.cells) ? row.cells : []) {
      const props =
        typeof raw === "object" && raw !== null
          ? ((raw as { props?: Record<string, unknown> }).props ?? {})
          : {}
      if (
        (typeof props.colspan === "number" && props.colspan > 1) ||
        (typeof props.rowspan === "number" && props.rowspan > 1)
      )
        found.add("merged table cells")
    }
  }
}

/* ------------------------------------------------------------- → blocks */

/**
 * Markdown, as the blocks a note is written from.
 *
 * A subset by design: the syntax `blocksToMarkdown` emits, plus what somebody
 * writing markdown by hand reasonably types. What it is not is a CommonMark
 * implementation — reference links, HTML blocks, setext headings and loose
 * definition lists are all read as the paragraphs they look like, which is a far
 * better failure than half-supporting them.
 */
export function markdownToBlocks(markdown: string): NoteBlock[] {
  return parseBlocks(markdown.replace(/\t/g, "    ").split(/\r?\n/))
}

const FENCE = /^(```|~~~)\s*([\w+#-]*)\s*$/
const HEADING = /^(#{1,6})\s+(.*)$/
const RULE = /^(-{3,}|\*{3,}|_{3,})\s*$/
const QUOTE = /^>\s?(.*)$/
const CHECK = /^[-*+]\s+\[([ xX])\]\s+(.*)$/
const BULLET = /^[-*+]\s+(.*)$/
const ORDERED = /^(\d{1,9})[.)]\s+(.*)$/
const IMAGE = /^!\[([^\]]*)\]\(\s*(<[^>]*>|\S+?)\s*\)$/
const DELIMITER = /^\|?(\s*:?-+:?\s*\|)+\s*:?-*:?\s*\|?$/

function parseBlocks(lines: string[]): NoteBlock[] {
  const blocks: NoteBlock[] = []
  let at = 0

  while (at < lines.length) {
    const raw = lines[at] ?? ""
    if (!raw.trim()) {
      at += 1
      continue
    }
    const line = raw.trim()

    const fence = FENCE.exec(line)
    if (fence) {
      const body: string[] = []
      at += 1
      while (at < lines.length && (lines[at] ?? "").trim() !== fence[1]) {
        body.push(lines[at] ?? "")
        at += 1
      }
      at += 1 // the closing fence, or the end of the document
      blocks.push(
        block("codeBlock", { language: fence[2] || "text" }, [
          { type: "text", text: body.join("\n"), styles: {} },
        ])
      )
      continue
    }

    const carried = MARKER.exec(line)
    if (carried) {
      const parsed = fromMarker(carried[1] ?? "", carried[2] ?? "")
      at += 1
      if (parsed) {
        blocks.push(parsed)
        continue
      }
      // Not JSON after all — a comment somebody wrote by hand. Left out rather
      // than shown, which is what a comment is for.
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      at += 1
      blocks.push(
        block(
          "heading",
          { ...TEXT_PROPS, level: heading[1]?.length ?? 1, isToggleable: false },
          parseInline(heading[2] ?? "")
        )
      )
      continue
    }

    if (RULE.test(line)) {
      at += 1
      blocks.push(block("divider", {}, []))
      continue
    }

    if (line.startsWith("|") && DELIMITER.test((lines[at + 1] ?? "").trim())) {
      const table = parseTable(lines, at)
      blocks.push(table.block)
      at = table.at
      continue
    }

    const quote = QUOTE.exec(line)
    if (quote) {
      const said: string[] = [quote[1] ?? ""]
      at += 1
      while (at < lines.length) {
        const next = QUOTE.exec((lines[at] ?? "").trim())
        if (!next) break
        said.push(next[1] ?? "")
        at += 1
      }
      blocks.push(
        block(
          "quote",
          { backgroundColor: "default", textColor: "default" },
          parseInline(join(said))
        )
      )
      continue
    }

    if (markerKind(line)) {
      const list = parseList(lines, at)
      blocks.push(...list.blocks)
      at = list.at
      continue
    }

    const image = IMAGE.exec(line)
    if (image) {
      at += 1
      const url = (image[2] ?? "").replace(/^<|>$/g, "")
      blocks.push(
        block("image", { name: "", url, caption: unescape(image[1] ?? "") }, null)
      )
      continue
    }

    // A paragraph: everything up to a blank line or the start of something else.
    const said = [line]
    at += 1
    while (at < lines.length) {
      const next = (lines[at] ?? "").trim()
      if (!next || opensABlock(next)) break
      said.push(next)
      at += 1
    }
    blocks.push(block("paragraph", { ...TEXT_PROPS }, parseInline(join(said))))
  }

  return blocks
}

const TEXT_PROPS = {
  backgroundColor: "default",
  textColor: "default",
  textAlignment: "left",
}

/** Whether a line begins a block rather than continuing a paragraph. */
function opensABlock(line: string): boolean {
  return (
    FENCE.test(line) ||
    MARKER.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    markerKind(line) !== null ||
    line.startsWith("|")
  )
}

/** Which list marker a line carries, and how wide it is. */
function markerKind(
  line: string
): { kind: ListKind; width: number; rest: string; start?: number } | null {
  const check = CHECK.exec(line)
  if (check) {
    return {
      kind: "check",
      // "- [x] " — the marker, the box and both spaces.
      width: line.length - (check[2] ?? "").length,
      rest: check[2] ?? "",
    }
  }
  const ordered = ORDERED.exec(line)
  if (ordered) {
    return {
      kind: "ordered",
      width: line.length - (ordered[2] ?? "").length,
      rest: ordered[2] ?? "",
      start: Number(ordered[1]),
    }
  }
  const bullet = BULLET.exec(line)
  if (bullet) {
    return {
      kind: "bullet",
      width: line.length - (bullet[1] ?? "").length,
      rest: bullet[1] ?? "",
    }
  }
  return null
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length
}

/**
 * A run of list items at one indent, with whatever is under them.
 *
 * Everything indented past an item's own text belongs to that item and is parsed
 * as blocks of its own — which is what makes a nested list nest, and a paragraph
 * written under a bullet a child of it rather than a new paragraph after the
 * list.
 */
function parseList(
  lines: string[],
  from: number
): { blocks: NoteBlock[]; at: number } {
  const base = indentOf(lines[from] ?? "")
  const kind = markerKind((lines[from] ?? "").trim())?.kind
  const blocks: NoteBlock[] = []
  let at = from
  let first = true

  while (at < lines.length) {
    // Blank lines between items belong to the list only if another item follows.
    let scan = at
    while (scan < lines.length && !(lines[scan] ?? "").trim()) scan += 1
    if (scan >= lines.length) break

    const line = lines[scan] ?? ""
    if (indentOf(line) !== base) break
    const marker = markerKind(line.trim())
    if (!marker || marker.kind !== kind) break

    at = scan + 1
    const content = base + marker.width
    const said = [marker.rest]
    const body: string[] = []

    while (at < lines.length) {
      const next = lines[at] ?? ""
      if (!next.trim()) {
        // Kept only if the item continues past it.
        let ahead = at
        while (ahead < lines.length && !(lines[ahead] ?? "").trim()) ahead += 1
        if (ahead < lines.length && indentOf(lines[ahead] ?? "") >= content) {
          body.push("")
          at += 1
          continue
        }
        break
      }
      if (indentOf(next) >= content) {
        body.push(next.slice(content))
        at += 1
        continue
      }
      // A wrapped sentence, indented less than the item's text or not at all.
      if (body.length === 0 && !opensABlock(next.trim())) {
        said.push(next.trim())
        at += 1
        continue
      }
      break
    }

    const props: Record<string, unknown> = { ...TEXT_PROPS }
    if (kind === "check") {
      props.checked = /[xX]/.test(CHECK.exec(line.trim())?.[1] ?? " ")
    }
    // Only the first item carries it: markdown numbers every item and a note
    // numbers the list once.
    if (first && kind === "ordered" && marker.start && marker.start !== 1) {
      props.start = marker.start
    }

    const item = block(
      kind === "ordered"
        ? "numberedListItem"
        : kind === "check"
          ? "checkListItem"
          : "bulletListItem",
      props,
      parseInline(join(said))
    )
    const children = parseBlocks(body)
    if (children.length) item.children = children
    blocks.push(item)
    first = false
  }

  return { blocks, at }
}

/** A GFM table. An empty header row is a note with no header row, which is the
 * shape `tableChunk` writes one in. */
function parseTable(
  lines: string[],
  from: number
): { block: NoteBlock; at: number } {
  const header = cellsIn((lines[from] ?? "").trim())
  let at = from + 2
  const body: string[][] = []

  while (at < lines.length) {
    const line = (lines[at] ?? "").trim()
    if (!line.startsWith("|")) break
    body.push(cellsIn(line))
    at += 1
  }

  const hasHeader = header.some((cell) => cell.trim().length > 0)
  const rows = (hasHeader ? [header, ...body] : body).map((cells) => ({
    cells: cells.map((cell) => ({
      type: "tableCell",
      content: parseInline(cell.trim()),
      props: { colspan: 1, rowspan: 1 },
    })),
  }))

  const content = { type: "tableContent", headerRows: hasHeader ? 1 : 0, rows }
  return { block: block("table", {}, content), at }
}

/** A row's cells, split on the pipes that are not escaped. */
function cellsIn(line: string): string[] {
  const cells: string[] = []
  let current = ""
  for (let at = 0; at < line.length; at++) {
    const character = line[at]
    if (character === "\\" && at + 1 < line.length) {
      current += line[at + 1]
      at += 1
      continue
    }
    if (character === "|") {
      cells.push(current)
      current = ""
      continue
    }
    current += character
  }
  cells.push(current)
  // The pipes at both ends produce an empty cell on either side of the row.
  if (cells.length && !cells[0]?.trim()) cells.shift()
  if (cells.length && !cells[cells.length - 1]?.trim()) cells.pop()
  return cells
}

/** A block back out of its comment, or null if what is in it is not one. */
function fromMarker(type: string, json: string): NoteBlock | null {
  try {
    const carried = JSON.parse(json) as {
      props?: Record<string, unknown>
      content?: unknown
    }
    return {
      id: randomUUID(),
      type,
      props: carried.props ?? {},
      ...(carried.content === undefined ? {} : { content: carried.content }),
    }
  } catch {
    return null
  }
}

/**
 * The lines of one paragraph, as the one string it is.
 *
 * A line ending in a backslash is markdown's hard break and is the only way a
 * newline inside a block survives the trip out and back — everything else is the
 * wrapping of a text file, which a paragraph does not keep.
 */
function join(lines: string[]): string {
  return lines.reduce((text, line, at) => {
    if (at === 0) return line
    return text.endsWith("\\") ? `${text.slice(0, -1)}\n${line}` : `${text} ${line}`
  }, "")
}

/** A fresh block. The id is a UUID because that is what the editor writes, and
 * because an id is what an edit is aimed at — see `outlineOf`. */
function block(
  type: string,
  props: Record<string, unknown>,
  content: unknown
): NoteBlock {
  return { id: randomUUID(), type, props, content }
}

/* ------------------------------------------------------------- → inline */

/**
 * One line of markdown, as the runs a block holds.
 *
 * Written as a scan rather than a grammar: at every position the question is only
 * "does something start here", and the answer is a run with one more style on it
 * than the caller had. That is what makes `**bold and _italic_**` two runs
 * without a stack to keep.
 */
function parseInline(text: string, styles: Record<string, boolean> = {}): unknown[] {
  const runs: unknown[] = []
  let literal = ""
  let at = 0

  const flush = (): void => {
    if (!literal) return
    runs.push({ type: "text", text: literal, styles: { ...styles } })
    literal = ""
  }

  while (at < text.length) {
    const rest = text.slice(at)

    if (rest.startsWith("\\") && rest.length > 1) {
      literal += rest[1]
      at += 2
      continue
    }

    const code = /^(`+)([\s\S]*?)\1(?!`)/.exec(rest)
    if (code) {
      flush()
      const body = code[2] ?? ""
      // The one space either side that let the span begin or end with a
      // backtick, taken back off — CommonMark's rule, and what `inlineOf` puts
      // there.
      const padded =
        body.length > 2 && body.startsWith(" ") && body.endsWith(" ") && body.trim()
      runs.push({
        type: "text",
        text: padded ? body.slice(1, -1) : body,
        styles: { ...styles, code: true },
      })
      at += code[0].length
      continue
    }

    const emphasis = EMPHASIS.find(([delimiter]) => rest.startsWith(delimiter))
    if (emphasis) {
      const [delimiter, style] = emphasis
      const closes = closeAt(rest, delimiter)
      if (closes > 0) {
        flush()
        runs.push(
          ...parseInline(rest.slice(delimiter.length, closes), {
            ...styles,
            [style]: true,
          })
        )
        at += closes + delimiter.length
        continue
      }
    }

    const anchor = /^\[((?:[^[\]\\]|\\.)*)\]\(\s*(<[^>]*>|[^)\s]*)(?:\s+"[^"]*")?\s*\)/.exec(
      rest
    )
    if (anchor) {
      flush()
      runs.push({
        type: "link",
        href: (anchor[2] ?? "").replace(/^<|>$/g, ""),
        content: parseInline(anchor[1] ?? "", styles),
      })
      at += anchor[0].length
      continue
    }

    literal += rest[0]
    at += 1
  }

  flush()
  return merge(runs)
}

/** Where the run this delimiter opened closes, or -1. A single `*` never closes
 * on the first half of a `**`. */
function closeAt(text: string, delimiter: string): number {
  for (let at = delimiter.length; at < text.length; at++) {
    if (text[at] === "\\") {
      at += 1
      continue
    }
    if (!text.startsWith(delimiter, at)) continue
    if (delimiter.length === 1 && text.startsWith(delimiter.repeat(2), at)) continue
    return at
  }
  return -1
}

/** Runs that differ in nothing, as the one run they are — which is what the
 * editor itself writes, and what keeps a round trip from splitting a sentence
 * into a word per character it had to escape. */
function merge(runs: unknown[]): unknown[] {
  const merged: unknown[] = []
  for (const run of runs) {
    const last = merged[merged.length - 1] as
      | { type?: string; text?: string; styles?: unknown }
      | undefined
    const next = run as { type?: string; text?: string; styles?: unknown }
    if (
      last?.type === "text" &&
      next.type === "text" &&
      JSON.stringify(last.styles) === JSON.stringify(next.styles)
    ) {
      last.text = `${last.text ?? ""}${next.text ?? ""}`
      continue
    }
    merged.push(run)
  }
  return merged
}

function unescape(text: string): string {
  return text.replace(/\\(.)/g, "$1")
}

function stringProp(block: NoteBlock | undefined, name: string): string {
  const value = block?.props?.[name]
  return typeof value === "string" ? value : ""
}

function numberProp(block: NoteBlock | undefined, name: string): number | null {
  const value = block?.props?.[name]
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : null
}
