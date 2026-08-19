import { spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { TOOLS } from "../src/mcp/tools"
import { Workspace } from "../src/mcp/workspace"
import type { NoteBlock } from "../src/protocol"

/**
 * The MCP server, against a real folder of real files.
 *
 * Two halves, and they are testing different claims. The tools are exercised
 * directly, because what they promise is about notes: an edit reaches one block
 * and leaves every other block's id alone, a write that would lose something says
 * so first, and a path out of the folder is refused. Then the server itself is
 * spawned and spoken to over its pipe, because the other half of the claim is
 * that a program which has never heard of VS Code can do all of that.
 */

let failures = 0

function check(what: string, ok: boolean, detail?: unknown) {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}`)
  if (!ok) {
    failures += 1
    if (detail !== undefined) console.log(`       ${String(detail)}`)
  }
}

const tool = (name: string) => {
  const found = TOOLS.find((candidate) => candidate.name === name)
  if (!found) throw new Error(`no tool ${name}`)
  return found
}

const root = await mkdtemp(join(tmpdir(), "notes-mcp-"))
const notes = new Workspace(root)

const START: NoteBlock[] = [
  {
    id: "id-heading",
    type: "heading",
    props: { backgroundColor: "default", textColor: "default", textAlignment: "left", level: 1, isToggleable: false },
    content: [{ type: "text", text: "Deploys", styles: {} }],
  },
  {
    id: "id-para",
    type: "paragraph",
    props: { backgroundColor: "default", textColor: "default", textAlignment: "left" },
    content: [{ type: "text", text: "The old way.", styles: {} }],
  },
  {
    id: "id-drawing",
    type: "drawing",
    props: { drawingId: "abc-123" },
    content: null,
  },
]

await writeFile(join(root, "Runbook.note"), JSON.stringify(START), "utf8")

console.log("the tools, over a folder of files")

{
  const listed = await tool("list_notes").run({}, notes)
  check("list_notes finds the note", listed.includes("Runbook.note"), listed)
}

{
  const markdown = await tool("read_note").run({ path: "Runbook.note" }, notes)
  check("read_note gives the words", markdown.includes("# Deploys"), markdown)
  check(
    "and carries the drawing rather than dropping it",
    markdown.includes('<!-- note drawing {"props":{"drawingId":"abc-123"}} -->'),
    markdown
  )
  check(
    "and names no files, because none of the ones it points at are there",
    !markdown.includes("Files this note points at"),
    markdown
  )
}

/*
 * The files a note points at, out of a folder that has both layouts in it.
 *
 * The listing is a walk of the *blocks* rather than of a directory, which is what
 * one shared assets directory forces: `readdir` would answer a question about one
 * note with every file every note has ever had. Both layouts are here because both
 * are read — a path with the shared directory on the front is relative to the root,
 * and one without is relative to the note, and getting those two the wrong way round
 * is a listing that quietly says nothing.
 */
{
  await mkdir(join(root, "anote.assets"), { recursive: true })
  await mkdir(join(root, "Runbook.note.assets"), { recursive: true })
  // The picture, in the shared directory, under the name it arrived with.
  await writeFile(join(root, "anote.assets", "báo cáo.png"), "png")
  // The drawing, still beside its note: made before the shared one existed.
  await writeFile(join(root, "Runbook.note.assets", "abc-123.excalidraw"), "{}")
  await writeFile(join(root, "Runbook.note.assets", "abc-123.svg"), "<svg/>")
  // Pointed at and not there, which must not be listed as though it were.
  const pointed: NoteBlock[] = [
    ...START,
    { id: "id-pic", type: "image", props: { url: "anote.assets/báo cáo.png" } },
    { id: "id-gone", type: "image", props: { url: "anote.assets/gone.png" } },
    { id: "id-out", type: "image", props: { url: "../../.ssh/id_rsa" } },
  ]
  await writeFile(join(root, "Runbook.note"), JSON.stringify(pointed), "utf8")

  const markdown = await tool("read_note").run({ path: "Runbook.note" }, notes)
  const line = markdown.split("\n").find((l) => l.startsWith("Files this note"))
  check(
    "the picture in the shared directory is listed, under its own name",
    line?.includes("anote.assets/báo cáo.png") ?? false,
    line
  )
  check(
    "the drawing beside its note is listed as the note spells it",
    (line?.includes("Runbook.note.assets/abc-123.excalidraw") ?? false) &&
      (line?.includes("Runbook.note.assets/abc-123.svg") ?? false),
    line
  )
  check(
    "one it points at that is not there is not",
    !(line?.includes("gone.png") ?? true),
    line
  )
  check(
    "and neither is one that climbs out of the folder",
    !(line?.includes("id_rsa") ?? true),
    line
  )

  await writeFile(join(root, "Runbook.note"), JSON.stringify(START), "utf8")
}

{
  const outline = await tool("read_note").run(
    { path: "Runbook.note", format: "outline" },
    notes
  )
  check(
    "the outline is one line per block, id first",
    outline.split("\n").length === 3 && outline.startsWith("id-heading  heading"),
    outline
  )
}

console.log("editing one block")

{
  await tool("edit_note").run(
    {
      path: "Runbook.note",
      ops: [
        { op: "replace", block: "id-para", markdown: "The **new** way." },
        { op: "insertAfter", block: "id-heading", markdown: "Read this first." },
      ],
    },
    notes
  )
  const after = await notes.read("Runbook.note")

  check("the heading kept its id", after[0]?.id === "id-heading")
  check("the drawing is still there", after.some((b) => b.id === "id-drawing"))
  check("the note grew by one block", after.length === 4, after.length)
  check(
    "the replaced block says the new thing",
    JSON.stringify(after[2]?.content).includes("new"),
    JSON.stringify(after[2])
  )
  check(
    "and is a block of its own, with a new id",
    after[2]?.id !== "id-para" && after[2]?.type === "paragraph"
  )
}

{
  const before = await readFile(join(root, "Runbook.note"), "utf8")
  const answer = await tool("edit_note")
    .run(
      {
        path: "Runbook.note",
        ops: [
          { op: "replace", block: "id-para-gone", markdown: "x" },
          { op: "delete", block: "id-drawing" },
        ],
      },
      notes
    )
    .catch((error: unknown) => String(error))
  const after = await readFile(join(root, "Runbook.note"), "utf8")

  check("an unknown id is refused", String(answer).includes("id-para-gone"), answer)
  check("and nothing at all was written", before === after)
}

console.log("what a whole-note rewrite would cost")

{
  await writeFile(
    join(root, "Coloured.note"),
    JSON.stringify([
      {
        id: "id-tinted",
        type: "paragraph",
        props: { textAlignment: "center" },
        content: [{ type: "text", text: "middle", styles: {} }],
      },
    ]),
    "utf8"
  )

  const refused = await tool("write_note").run(
    { path: "Coloured.note", markdown: "plain" },
    notes
  )
  check("write_note refuses to lose the alignment", refused.startsWith("Refused"), refused)
  check(
    "and the note is untouched",
    (await notes.read("Coloured.note"))[0]?.id === "id-tinted"
  )

  const forced = await tool("write_note").run(
    { path: "Coloured.note", markdown: "plain", force: true },
    notes
  )
  check("force writes it and says what went", forced.includes("Lost: alignment"), forced)
}

console.log("what it will not do")

for (const [what, path] of [
  ["a path climbing out of the folder", "../secrets.note"],
  ["an absolute path", "/etc/hosts.note"],
  ["a file that is not a note", "package.json"],
] as const) {
  const answer = await tool("read_note")
    .run({ path }, notes)
    .catch((error: unknown) => `refused: ${String(error)}`)
  check(what, String(answer).startsWith("refused:"), answer)
}

console.log("appending, and creating")

{
  await tool("create_note").run(
    { path: "Nested/New.note", markdown: "# Fresh\n\n- one\n- two" },
    notes
  )
  const made = await notes.read("Nested/New.note")
  check("create_note wrote a note in a folder it made", made.length === 3, made.length)
  check("every block has an id", made.every((block) => Boolean(block.id)))

  const again = await tool("create_note")
    .run({ path: "Nested/New.note", markdown: "x" }, notes)
    .catch((error: unknown) => `refused: ${String(error)}`)
  check("and will not overwrite one", String(again).startsWith("refused:"))

  await tool("append_note").run(
    { path: "Nested/New.note", markdown: "And a last word." },
    notes
  )
  const appended = await notes.read("Nested/New.note")
  check("append_note added to the end", appended.length === 4)
  check(
    "leaving the ids above it alone",
    appended.slice(0, 3).every((block, at) => block.id === made[at]?.id)
  )
}

{
  const found = await tool("search_notes").run({ query: "fresh" }, notes)
  check("search_notes finds it, whatever the case", found.includes("Nested/New.note"), found)
}

{
  const empty = join(root, "Empty.note")
  await writeFile(empty, "", "utf8")
  check("an empty file is an empty note", (await notes.read("Empty.note")).length === 0)

  await writeFile(join(root, "Broken.note"), "{ not json", "utf8")
  const answer = await notes
    .read("Broken.note")
    .then(() => "read it anyway")
    .catch((error: unknown) => `refused: ${String(error)}`)
  check(
    "a file that does not parse stops the read rather than emptying the note",
    String(answer).startsWith("refused:"),
    answer
  )
}

console.log("blocks the editor has no spec for")

{
  /* A note the editor cannot open — the shape of `sample/spec.note`, whose column
     blocks come from a BlockNote extension this build does not include. The point
     of every check here is that the tools say so rather than letting a model hand
     back a note nobody can edit. */
  await writeFile(
    join(root, "Columns.note"),
    JSON.stringify([
      { id: "id-title", type: "heading", props: { level: 1 }, content: [{ type: "text", text: "Spec", styles: {} }] },
      {
        id: "id-cols",
        type: "columnList",
        props: {},
        children: [
          {
            id: "id-col",
            type: "column",
            props: { width: 1 },
            children: [
              { id: "id-inner", type: "paragraph", props: {}, content: [{ type: "text", text: "inside", styles: {} }] },
            ],
          },
        ],
      },
    ]),
    "utf8"
  )

  const read = await tool("read_note").run({ path: "Columns.note" }, notes)
  check(
    "read_note warns at the top, naming both types",
    read.startsWith("⚠") && read.includes("column, columnList"),
    read.slice(0, 160)
  )
  check("and still hands over the note's words", read.includes("# Spec"), read.slice(0, 200))
  check(
    "the warning says what to do about it",
    read.includes("format=json") && read.includes("nested under it"),
    read.slice(0, 400)
  )

  const outline = await tool("read_note").run(
    { path: "Columns.note", format: "outline" },
    notes
  )
  check("the outline is warned about too", outline.startsWith("⚠"), outline.slice(0, 80))

  const listed = await tool("list_notes").run({}, notes)
  check(
    "list_notes marks it before anybody opens it",
    /Columns\.note.*not editable: column, columnList/.test(listed),
    listed
  )

  // A note the editor *can* open must say none of this.
  const clean = await tool("read_note").run({ path: "Runbook.note" }, notes)
  check("a note the editor can open is not warned about", !clean.includes("⚠"), clean.slice(0, 120))
}

console.log("writes cannot introduce one")

{
  const marker = '<!-- note columnList {"props":{}} -->'
  const before = await readFile(join(root, "Runbook.note"), "utf8")

  const appended = await tool("append_note")
    .run({ path: "Runbook.note", markdown: marker }, notes)
    .catch((error: unknown) => `refused: ${String(error)}`)
  check(
    "append_note refuses a marker naming an unsupported type",
    String(appended).startsWith("refused:") && String(appended).includes("columnList"),
    appended
  )
  check(
    "and wrote nothing",
    before === (await readFile(join(root, "Runbook.note"), "utf8"))
  )

  const created = await tool("create_note")
    .run({ path: "Bad.note", markdown: `# Title\n\n${marker}` }, notes)
    .catch((error: unknown) => `refused: ${String(error)}`)
  check("create_note refuses it too", String(created).startsWith("refused:"), created)
  check("and made no file", !(await notes.exists("Bad.note")))

  const replaced = await tool("write_note")
    .run({ path: "Runbook.note", markdown: marker, force: true }, notes)
    .catch((error: unknown) => `refused: ${String(error)}`)
  check("write_note refuses it even with force", String(replaced).startsWith("refused:"), replaced)

  /* The asymmetry: a type the note already had is carried, because refusing it
     would make an unopenable note unfixable. */
  const kept = await tool("append_note").run(
    { path: "Columns.note", markdown: "One more line." },
    notes
  )
  check(
    "a type the note already had does not block an edit",
    !String(kept).startsWith("refused:"),
    kept
  )
  check("but the answer still warns about it", String(kept).includes("⚠"), kept)

  /* And the fix path works: replace the wrapper, and the note becomes editable. */
  await tool("edit_note").run(
    {
      path: "Columns.note",
      ops: [{ op: "replace", block: "id-cols", markdown: "| Screen | Guard |\n| --- | --- |\n| S-013 | guest |" }],
    },
    notes
  )
  const fixed = await tool("read_note").run({ path: "Columns.note" }, notes)
  check(
    "replacing the wrapper makes the note editable again",
    !fixed.includes("⚠") && fixed.includes("| Screen | Guard |"),
    fixed.slice(0, 300)
  )
}

console.log("the server itself, over its pipe")

{
  const answers = await speak(
    [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "read_note", arguments: { path: "Runbook.note", format: "outline" } },
      },
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "read_note", arguments: { path: "Nope.note" } },
      },
      { jsonrpc: "2.0", id: 5, method: "resources/list" },
    ],
    5
  )

  const initialize = answers.find((answer) => answer.id === 1)
  check(
    "it answers initialize in the version it was asked in",
    (initialize?.result as { protocolVersion?: string })?.protocolVersion === "2025-06-18",
    JSON.stringify(initialize)
  )
  check(
    "the notification got no answer",
    answers.every((answer) => answer.id !== undefined && answer.id !== null)
  )

  const tools = (answers.find((answer) => answer.id === 2)?.result ?? {}) as {
    tools?: { name: string; inputSchema?: unknown }[]
  }
  check(
    "every tool is listed with a schema",
    tools.tools?.length === TOOLS.length &&
      tools.tools.every((each) => Boolean(each.inputSchema)),
    JSON.stringify(tools.tools?.map((each) => each.name))
  )

  const called = (answers.find((answer) => answer.id === 3)?.result ?? {}) as {
    content?: { text?: string }[]
  }
  check(
    "a tool call comes back as text",
    Boolean(called.content?.[0]?.text?.includes("id-heading")),
    JSON.stringify(called)
  )

  const missing = (answers.find((answer) => answer.id === 4)?.result ?? {}) as {
    isError?: boolean
  }
  check(
    "a note that is not there is the tool's answer, not a protocol error",
    missing.isError === true,
    JSON.stringify(answers.find((answer) => answer.id === 4))
  )

  const undeclared = answers.find((answer) => answer.id === 5)
  check(
    "a method it never claimed to have is method-not-found",
    (undeclared?.error as { code?: number })?.code === -32601,
    JSON.stringify(undeclared)
  )
}

console.log(failures === 0 ? "\nall ok" : `\n${failures} failed`)
if (failures > 0) process.exit(1)

/**
 * Runs the server, sends it these messages, and collects the answers until it has
 * `expected` of them or five seconds have gone by.
 *
 * `process.execPath` is whatever is running this file — bun, here, which reads
 * the TypeScript directly. What a client would start is `dist/mcp.js`, and the
 * only difference between the two is the build.
 */
function speak(
  messages: unknown[],
  expected: number
): Promise<{ id?: unknown; result?: unknown; error?: unknown }[]> {
  return new Promise((done) => {
    const server = spawn(process.execPath, ["src/mcp/main.ts", root], {
      stdio: ["pipe", "pipe", "pipe"],
    })
    const answers: { id?: unknown; result?: unknown; error?: unknown }[] = []
    let buffered = ""

    const finish = () => {
      server.kill()
      done(answers)
    }
    const timer = setTimeout(finish, 5_000)

    server.stdout.setEncoding("utf8")
    server.stdout.on("data", (chunk: string) => {
      buffered += chunk
      for (;;) {
        const end = buffered.indexOf("\n")
        if (end < 0) break
        const line = buffered.slice(0, end).trim()
        buffered = buffered.slice(end + 1)
        if (!line) continue
        try {
          answers.push(JSON.parse(line))
        } catch {
          check("the server wrote something that was not JSON", false, line)
        }
        if (answers.length >= expected) {
          clearTimeout(timer)
          finish()
          return
        }
      }
    })

    for (const message of messages) {
      server.stdin.write(`${JSON.stringify(message)}\n`)
    }
  })
}
