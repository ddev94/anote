import { resolve } from "node:path"

import { EDITOR_BLOCK_TYPES } from "../note-schema"
import { messageOf, TOOLS } from "./tools"
import { configIn, Refused, Workspace } from "./workspace"

/**
 * The notes in a folder, as an MCP server — so that something other than a person
 * can read and write them.
 *
 * **Why this is a separate process and not part of the extension.** A note is a
 * file, which is the decision the whole extension rests on, and the dividend is
 * this: reading and writing one needs a filesystem and nothing else. No VS Code,
 * no webview, no editor mounted, no window open. The extension and this server
 * are two programs over one format rather than one program with an API bolted to
 * it, and the format is the API.
 *
 * **Hand-written rather than the MCP SDK**, on the same grounds as
 * `note-server.ts` next door being a hand-written HTTP server: the protocol
 * here is newline-delimited JSON-RPC with four methods on it, all of it visible
 * below, and a dependency would be more code in the bundle than the thing it
 * implements. What that costs is the extensions of the protocol this does not
 * implement — resources, prompts, sampling, progress — none of which a set of
 * tools over a folder of files has any use for.
 *
 * **stdout carries the protocol and nothing else.** A stray `console.log`
 * anywhere under this file is a parse error at the other end, which is why every
 * word this server says about itself goes to stderr.
 */

/** The versions of the protocol this speaks. It answers in the client's, when the
 * client asks in one it knows — a date it has never heard of gets this one, and
 * the client decides whether that is a conversation it wants. */
const PROTOCOL = "2025-06-18"
const SPOKEN = new Set([PROTOCOL, "2025-03-26", "2024-11-05"])

type Request = {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: Record<string, unknown>
}

/* The root, in the order the ways of naming one get to answer: the argument the
   extension passes (already resolved through `notesDir` on its side), then the
   environment for whoever wired this up by hand, then here.

   The config is looked for somewhere else, and has to be: `anote.config.json`
   sits at the root of a *workspace folder*, and `notesDir` may have sent the
   notes into a subdirectory of it — so the extension says which folder the file
   is in rather than leaving this process to guess by walking up. Nothing set it,
   which is every client but the extension, and the root is the best guess there
   is. */
const root = resolve(process.argv[2] ?? process.env.ANOTE_ROOT ?? process.cwd())
const notes = new Workspace(root, configIn(process.env.ANOTE_CONFIG_DIR ?? root))

process.stderr.write(`anote mcp: reading ${notes.root}\n`)

/* One line, one message — and a message split across two chunks is common enough
   over a pipe that the buffer is the whole of what this loop is for. */
let buffered = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk: string) => {
  buffered += chunk
  for (;;) {
    const end = buffered.indexOf("\n")
    if (end < 0) break
    const line = buffered.slice(0, end).trim()
    buffered = buffered.slice(end + 1)
    if (line) void handle(line)
  }
})
/* Nothing here on `end`. A client closing the pipe is a client that has stopped
   asking, not one that has stopped waiting — an `exit()` on this event drops the
   answers to whatever is still in flight, which is every answer at all when the
   requests arrive faster than a file can be read. With no handler the process
   ends when the last of them has been written, which is the same shutdown one
   message later. */

async function handle(line: string): Promise<void> {
  let request: Request
  try {
    request = JSON.parse(line) as Request
  } catch {
    // No id to answer against, so there is nobody to tell.
    process.stderr.write("anote mcp: a line that was not JSON\n")
    return
  }

  // A notification — `initialized`, `cancelled` — is a message with no id, and
  // the protocol says an answer to one is an error.
  if (request.id === undefined || request.id === null) return

  try {
    reply(request.id, await answer(request))
  } catch (error) {
    // Method-not-found is the one a client acts on rather than shows: it is how
    // it discovers that a capability this server never declared is not there.
    const code = error instanceof MethodMissing ? -32601 : -32603
    fail(request.id, code, messageOf(error))
  }
}

async function answer(request: Request): Promise<unknown> {
  switch (request.method) {
    case "initialize": {
      const asked = request.params?.protocolVersion
      return {
        protocolVersion:
          typeof asked === "string" && SPOKEN.has(asked) ? asked : PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: "anote", version: "0.1.0" },
        instructions:
          "Notes kept as .note files — block documents the ANote VS Code " +
          "extension edits. Read one with read_note (format=markdown for what " +
          "it says, format=outline for the block ids to edit by). Change part " +
          "of a note with edit_note, which leaves every other block untouched; " +
          "write_note replaces the lot and is the one that loses things.\n\n" +
          /*
           * Said here as well as on every tool that writes.
           *
           * `instructions` is the one thing a client reads before it has called
           * anything, so it is where a rule belongs that is cheaper to follow than
           * to be corrected on. The tools still check — a model may never see this
           * — but a refusal is a wasted turn, and this is what avoids it.
           */
          `A note may only hold these block types: ${EDITOR_BLOCK_TYPES.join(", ")}. ` +
          "Writing markdown always produces these and nothing else. The " +
          "<!-- note <type> {…} --> comment carries a block verbatim so that a " +
          "video, an audio clip, an attachment or a drawing survives a round trip " +
          "— it must only ever name a type from that list. A note holding any " +
          "other type still reads and writes here, and the editor shows it as a " +
          "read-only listing of its JSON rather than something anyone can edit — " +
          "read_note says so at the top when a note is in that state.",
      }
    }

    case "ping":
      return {}

    case "tools/list":
      return {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        })),
      }

    case "tools/call": {
      const name = String(request.params?.name ?? "")
      const tool = TOOLS.find((candidate) => candidate.name === name)
      if (!tool) throw new Refused(`No tool called ${name}.`)

      const args = (request.params?.arguments ?? {}) as Record<string, unknown>
      try {
        return { content: [{ type: "text", text: await tool.run(args, notes) }] }
      } catch (error) {
        /*
         * A tool that would not do what was asked answers rather than errors.
         *
         * The distinction the protocol draws, and it matters here more than
         * usual: a JSON-RPC error is a fault in the call and the client deals
         * with it, while `isError` is the tool's own answer and goes to whatever
         * is doing the asking. "That block id is not in this note, here is how to
         * find one that is" is only useful to the reader.
         */
        return {
          content: [{ type: "text", text: messageOf(error) }],
          isError: true,
        }
      }
    }

    default:
      throw new MethodMissing(`No method ${request.method}.`)
  }
}

class MethodMissing extends Error {}

function reply(id: string | number, result: unknown): void {
  send({ jsonrpc: "2.0", id, result })
}

function fail(id: string | number, code: number, message: string): void {
  send({ jsonrpc: "2.0", id, error: { code, message } })
}

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}
