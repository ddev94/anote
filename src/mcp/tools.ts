import {
  blocksToMarkdown,
  markdownToBlocks,
  outlineOf,
  plainTextOf,
  whatMarkdownDrops,
} from "../host/note-markdown"
import { EDITOR_BLOCK_TYPES, typesNotKnownBy } from "../note-schema"
import type { NoteBlock } from "../protocol"
import { Refused, type Workspace } from "./workspace"

/**
 * What a model can do to a note.
 *
 * The shape of this list is the argument the whole `src/mcp/` directory is
 * making, so it is worth saying what it is. A note is JSON on disk, so anything
 * with a filesystem can already open one — badly: the file is one long line of
 * blocks with a UUID and six props each, a sentence costs a thousand tokens to
 * read and an exact string match to change, and an edit that gets a prop wrong is
 * a note the editor renders as something else.
 *
 * So the tools are built around the two documents a note really has. **Markdown**
 * is what it says, and it is what you read and what you write new writing in.
 * **The outline** is what it is made of — one line per block, id first — and it is
 * what an edit is aimed at. Reading the whole note to change one paragraph is the
 * thing this is designed to make unnecessary: read the outline, replace the block.
 *
 * The one rule underneath all of them: **a block that was not edited keeps its
 * id.** That is not tidiness. The editor holds the caret, the undo stack and the
 * selection by block id, so a write that mints new ids for a note somebody has
 * open is a note that jumps under them.
 */
export type Tool = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  run: (args: Record<string, unknown>, notes: Workspace) => Promise<string>
}

/**
 * The warning every tool that writes carries.
 *
 * VS Code writes nothing to disk until the note is saved, and it does not reload
 * a document it has unsaved changes in. So a write from here into a note that is
 * open and dirty is a write the next ⌘S silently undoes — and there is no way to
 * find that out from outside the editor, which is exactly what an MCP server run
 * by the extension itself would fix.
 */
const UNSAVED =
  "If the note is open in VS Code with unsaved changes, save it first — " +
  "this writes the file, and an unsaved editor would overwrite what it wrote."

/**
 * The other warning, and the more useful of the two, because it is the one that
 * can be obeyed in advance.
 *
 * Ordinary markdown can only ever produce blocks the editor has — the parser has
 * no syntax for anything else. The one way through is the comment marker, which
 * exists so that a video or a drawing survives a round trip and will just as
 * happily carry a `columnList` that this build cannot open. So the rule is said
 * here, checked in `refuseNewTypes`, and repeated in the server's `instructions`:
 * three places, because a model that has read none of them still cannot get it
 * wrong.
 */
const BLOCK_TYPES =
  `The editor can only edit these block types: ${EDITOR_BLOCK_TYPES.join(", ")}. ` +
  `Plain markdown always produces these and nothing else. The <!-- note <type> {…} --> ` +
  `comment carries a block verbatim, so it must only ever name one of them — any other ` +
  `type is shown in the editor as a read-only listing of its JSON, which nobody can edit.`

/** What to say about a note holding blocks the editor has no spec for, or "" for
 * one it can open. Reported rather than refused: the note is on disk either way,
 * and a model asked to *fix* one needs to be able to read and edit it. */
function unopenable(blocks: NoteBlock[]): string {
  const missing = typesNotKnownBy(blocks)
  if (missing.length === 0) return ""

  return (
    `⚠ This note holds ${missing.join(", ")}, which the Notes editor has no block spec ` +
    `for. The rest of the note edits normally; those blocks are shown there as a ` +
    `read-only listing of their JSON, so they can be moved or deleted by hand but not ` +
    `changed. To make one editable, replace it with supported blocks — read format=json ` +
    `to see its shape, and note that a wrapper block's text is all in the blocks nested ` +
    `under it, so a table or plain paragraphs usually carry the same content.`
  )
}

/**
 * Stops a write that would put a block the editor cannot open into a note that
 * did not have one.
 *
 * The asymmetry is the point. A type already in the note is left alone — refusing
 * it would make an unopenable note unfixable, which is the opposite of what is
 * wanted. A type the write *introduces* is refused outright, because there is no
 * good reason to write one and the cost of doing it by accident is a note that
 * silently stops opening.
 */
function refuseNewTypes(before: NoteBlock[], after: NoteBlock[]): void {
  const had = new Set(typesNotKnownBy(before))
  const added = typesNotKnownBy(after).filter((type) => !had.has(type))
  if (added.length === 0) return

  throw new Refused(
    `Refused: this would add ${added.join(", ")}, which the editor has no block spec ` +
      `for — it would show as a read-only JSON listing rather than something anyone can ` +
      `edit. ${BLOCK_TYPES} Nothing has been written.`
  )
}

export const TOOLS: Tool[] = [
  {
    name: "list_notes",
    description:
      "Every .note file in the notes folder, with how many blocks each holds, " +
      "and which folder that is. Start here when you do not already know a " +
      "note's path.",
    inputSchema: { type: "object", properties: {} },
    run: async (_args, notes) => {
      const paths = await notes.notes()
      /*
       * The folder, always, and first.
       *
       * Which folder this server is serving is decided by whatever started it —
       * an argument, an environment variable, or the working directory it was
       * spawned in — and none of those are visible from where the answer is
       * read. Without this line an empty list is unreadable: a folder with no
       * notes in it and a server pointed somewhere nobody meant look exactly the
       * same, and the second one is a configuration mistake that could go a long
       * way before anybody noticed.
       */
      if (paths.length === 0) return `No .note files under ${notes.root} yet.`

      const lines = [`${paths.length} notes under ${notes.root}`, ""]
      for (const path of paths) {
        try {
          const blocks = await notes.read(path)
          const missing = typesNotKnownBy(blocks)
          lines.push(
            `${path}  —  ${blocks.length} blocks` +
              // Marked here as well as in `read_note`, so that a note nobody can
              // open is visible before anybody opens it.
              (missing.length ? `  —  ⚠ not editable: ${missing.join(", ")}` : "")
          )
        } catch (error) {
          lines.push(`${path}  —  ${messageOf(error)}`)
        }
      }
      return lines.join("\n")
    },
  },

  {
    name: "read_note",
    description:
      "A note, in one of three readings. `markdown` is what it says — read this " +
      "to answer a question about a note's contents. `outline` is one line per " +
      "block, id first, and is what you need before editing: it is far cheaper " +
      "than the markdown and it is where the block ids come from. `json` is the " +
      "blocks exactly as the file holds them, for when a prop matters.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the .note file, relative to the notes folder." },
        format: {
          type: "string",
          enum: ["markdown", "outline", "json"],
          description: "Defaults to markdown.",
        },
      },
      required: ["path"],
    },
    run: async (args, notes) => {
      const path = stringArg(args, "path")
      const blocks = await notes.read(path)
      // First, not last: it changes what to do with everything below it.
      const warning = unopenable(blocks)
      const body = (text: string) => (warning ? `${warning}\n\n---\n\n${text}` : text)

      switch (args.format ?? "markdown") {
        case "outline":
          return body(outlineOf(blocks) || "(an empty note)")
        case "json":
          return body(JSON.stringify(blocks, null, 2))
        default: {
          const markdown = blocksToMarkdown(blocks)
          const assets = await notes.assets(path, blocks)
          return body(
            (markdown || "(an empty note)") +
              (assets.length
                ? `\n\nFiles this note points at: ${assets.join(", ")}`
                : "")
          )
        }
      }
    },
  },

  {
    name: "create_note",
    description:
      "A new note, from markdown. Fails rather than overwriting if the path is " +
      `already taken. The folders above it are created if they are missing. ${BLOCK_TYPES}`,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Where to put it, ending in .note." },
        markdown: { type: "string", description: "The note's contents. Optional — leave it out for an empty note." },
      },
      required: ["path"],
    },
    run: async (args, notes) => {
      const path = stringArg(args, "path")
      if (await notes.exists(path)) {
        throw new Refused(`${path} already exists — write_note replaces one.`)
      }
      const blocks = markdownToBlocks(String(args.markdown ?? ""))
      refuseNewTypes([], blocks)
      await notes.write(path, blocks)
      return `Wrote ${path} — ${blocks.length} blocks.`
    },
  },

  {
    name: "append_note",
    description:
      "Adds markdown to the end of a note. The safest way to write into one: " +
      `every block already there keeps its id and its formatting. ${UNSAVED} ${BLOCK_TYPES}`,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        markdown: { type: "string", description: "What to add." },
      },
      required: ["path", "markdown"],
    },
    run: async (args, notes) => {
      const path = stringArg(args, "path")
      const existing = await notes.read(path)
      const added = markdownToBlocks(stringArg(args, "markdown"))
      if (added.length === 0) return "Nothing to add."
      refuseNewTypes(existing, added)
      await notes.write(path, [...existing, ...added])
      return (
        `Added ${added.length} blocks to ${path}. It now has ${existing.length + added.length}.` +
        after(unopenable(existing))
      )
    },
  },

  {
    name: "edit_note",
    description:
      "Changes named blocks and leaves the rest of the note alone — the tool to " +
      "reach for when a note already has something in it. Every operation names " +
      "a block by the id `read_note` with format=outline gives you. All of them " +
      "are applied together or none are, so a wrong id changes nothing. " +
      `${UNSAVED} ${BLOCK_TYPES}`,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        ops: {
          type: "array",
          description: "Applied in order, each against the note as the ones before it left it.",
          items: {
            type: "object",
            properties: {
              op: {
                type: "string",
                enum: ["replace", "insertAfter", "insertBefore", "delete"],
              },
              block: { type: "string", description: "The id of the block to act on." },
              markdown: {
                type: "string",
                description: "The new writing, for every op but delete. May be several blocks.",
              },
            },
            required: ["op", "block"],
          },
        },
      },
      required: ["path", "ops"],
    },
    run: async (args, notes) => {
      const path = stringArg(args, "path")
      const ops = Array.isArray(args.ops) ? args.ops : []
      if (ops.length === 0) throw new Refused("No operations to apply.")

      // A copy, so a failure halfway through is a note nothing happened to.
      let blocks = JSON.parse(JSON.stringify(await notes.read(path))) as NoteBlock[]
      const done: string[] = []

      for (const raw of ops) {
        const op = raw as Record<string, unknown>
        const id = stringArg(op, "block")
        const kind = String(op.op ?? "")
        const added =
          kind === "delete" ? [] : markdownToBlocks(String(op.markdown ?? ""))

        if (kind !== "delete" && added.length === 0) {
          throw new Refused(`${kind} on ${id} has no markdown to put there.`)
        }

        const changed = splice(blocks, id, kind, added)
        if (!changed) {
          throw new Refused(
            `No block with id ${id} in ${path}. Read it with format=outline for the ids it does have — nothing has been written.`
          )
        }
        blocks = changed
        done.push(`${kind} ${id}`)
      }

      refuseNewTypes(await notes.read(path), blocks)
      await notes.write(path, blocks)
      return (
        `${done.join(", ")}. ${path} now has ${blocks.length} top-level blocks.` +
        after(unopenable(blocks))
      )
    },
  },

  {
    name: "write_note",
    description:
      "Replaces a whole note with markdown. Every block gets a new id, so prefer " +
      "edit_note or append_note for a note that already has something in it. " +
      "If the note holds anything markdown cannot carry, this refuses and says " +
      `what — pass force to do it anyway. ${UNSAVED} ${BLOCK_TYPES}`,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        markdown: { type: "string" },
        force: {
          type: "boolean",
          description: "Write even though something in the note will be lost.",
        },
      },
      required: ["path", "markdown"],
    },
    run: async (args, notes) => {
      const path = stringArg(args, "path")
      const existing = await notes.read(path)
      const drops = whatMarkdownDrops(existing)

      if (drops.length > 0 && args.force !== true) {
        return (
          `Refused: rewriting ${path} through markdown would lose ${drops.join(", ")}.\n` +
          `Use edit_note to change part of it instead, or call this again with force=true.`
        )
      }

      const blocks = markdownToBlocks(stringArg(args, "markdown"))
      refuseNewTypes(existing, blocks)
      await notes.write(path, blocks)
      return (
        `Replaced ${path} — ${existing.length} blocks became ${blocks.length}.` +
        (drops.length ? ` Lost: ${drops.join(", ")}.` : "") +
        after(unopenable(blocks))
      )
    },
  },

  {
    name: "search_notes",
    description:
      "The notes with a phrase in them, and the lines it is on. Case-insensitive.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
      },
      required: ["query"],
    },
    run: async (args, notes) => {
      const query = stringArg(args, "query").toLowerCase()
      if (!query) throw new Refused("Nothing to search for.")

      const found: string[] = []
      for (const path of await notes.notes()) {
        let blocks: NoteBlock[]
        try {
          blocks = await notes.read(path)
        } catch {
          continue
        }
        const hits = blocks
          .map((block) => plainTextOf(block.content).replace(/\s+/g, " ").trim())
          .filter((line) => line.toLowerCase().includes(query))
        if (hits.length) {
          found.push(`${path}\n${hits.slice(0, 5).map((line) => `  ${line}`).join("\n")}`)
        }
      }

      return found.length ? found.join("\n\n") : `Nothing matches "${args.query}".`
    },
  },
]

/**
 * The note with one block replaced, added beside or taken out — or null if no
 * block has that id.
 *
 * Recursive, because a note nests: a bullet under a bullet is a block with an id
 * like any other, and an edit that could only reach the top level would be an
 * edit that cannot touch half a list.
 */
function splice(
  blocks: NoteBlock[],
  id: string,
  op: string,
  added: NoteBlock[]
): NoteBlock[] | null {
  const out: NoteBlock[] = []
  let hit = false

  for (const block of blocks) {
    if (block.id === id) {
      hit = true
      switch (op) {
        case "delete":
          break
        case "insertBefore":
          out.push(...added, block)
          break
        case "insertAfter":
          out.push(block, ...added)
          break
        default:
          out.push(...added)
      }
      continue
    }

    if (block.children?.length) {
      const children = splice(block.children, id, op, added)
      if (children) {
        hit = true
        out.push({ ...block, children })
        continue
      }
    }
    out.push(block)
  }

  return hit ? out : null
}

/** A warning on the end of an answer that has one, and nothing at all otherwise —
 * so a write that went fine reads as one sentence. */
function after(warning: string): string {
  return warning ? `\n\n${warning}` : ""
}

function stringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name]
  if (typeof value !== "string") throw new Refused(`Missing "${name}".`)
  return value
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
