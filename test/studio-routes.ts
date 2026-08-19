import { connect } from "node:net"

import { NoteServer } from "../src/host/note-server"
import type { StudioWorkspace } from "../src/host/studio-routes"
import {
  API,
  BOOT_ID,
  READ,
  PATH_PARAM,
  FILE_PARAM,
  TOKEN_HEADER,
  VERSION_HEADER,
  type NoteResult,
  type NotesResult,
  type Problem,
  type SavedResult,
  type StudioBoot,
  type UploadedResult,
} from "../src/studio-api"
import type { NoteBlock } from "../src/protocol"

/**
 * The studio, fetched over a real socket from a real server.
 *
 * The most worth testing of anything in this extension, and for a reason
 * `test/preview-pages.ts` — the other half of the same port — only half had: these
 * routes *write*. Every check below is a
 * seam — the token that stands in front of every write, the version a save has to
 * be made against, the path that cannot climb out of the notes folder, and the one
 * route that serves files, which must serve a note's pictures and nothing else in
 * the workspace.
 *
 * It runs here at all because `studio-routes.ts` imports no `vscode`: the workspace
 * arrives as the functions in `StudioWorkspace`, so a test can be the thing that
 * supplies them — here, a `Map` of two notes and a picture.
 *
 * The last section is the merge itself: one origin, and the two ways across it — a
 * page of a note nobody registered, and the **Edit** link that page carries back to
 * the studio.
 */

let failures = 0

function check(what: string, ok: boolean, detail?: unknown) {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}`)
  if (!ok) {
    failures += 1
    if (detail !== undefined) console.log(`       ${String(detail)}`)
  }
}

/** A 1×1 PNG, as the bytes a note's own directory would hold. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64"
)

const BLOCKS: NoteBlock[] = [
  {
    type: "heading",
    props: { level: 2 },
    content: [{ type: "text", text: "Endpoints", styles: {} }],
  },
  { type: "image", props: { url: "Spec.note.assets/shape.png" } },
]

/** The workspace, as a couple of maps — which is the whole point of the boundary
 * this server is written against. */
const notes = new Map<string, string>([
  ["auth/Spec.note", JSON.stringify(BLOCKS)],
  ["Welcome.note", ""],
])
const files = new Map<string, Buffer>([
  // A note written before the shared assets directory: its own, beside it.
  ["auth/Spec.note.assets/shape.png", PNG],
  // One dropped in since: the workspace's directory, at the notes root, under
  // the name the file arrived with.
  ["anote.assets/báo cáo.png", PNG],
  // Something in the notes folder that is not one of the notes' files. Nothing
  // must serve it.
  [".env", Buffer.from("SECRET=1")],
])
const assets = new Map<string, Buffer>()
const uploads: string[] = []

const workspace: StudioWorkspace = {
  notes: async () => [...notes.keys()],
  read: async (path) => notes.get(path) ?? null,
  write: async (path, text) => void notes.set(path, text),
  create: async (path) => {
    if (notes.has(path)) return false
    notes.set(path, "")
    return true
  },
  file: async (path) => files.get(path) ?? null,
  exists: async (path) => files.has(path),
  readAsset: async (note, name) => assets.get(`${note}/${name}`) ?? null,
  writeAsset: async (note, name, bytes) =>
    void assets.set(`${note}/${name}`, Buffer.from(bytes)),
  upload: async (note, name, mime, bytes) => {
    uploads.push(`${note} ${name} ${mime} ${bytes.byteLength}`)
    return `anote.assets/${name}`
  },
  bundle: async (name) =>
    name === "studio.js" ? Buffer.from("// the studio") : null,
}

/* One server, and the studio mounted on it — which is what the extension's `Studio`
   does when a command asks for either surface. */
const server = new NoteServer(() => ({ theme: "dark", pollMs: 1500, port: 0 }))
server.mountStudio(workspace, () => ({
  pollMs: 1500,
  theme: "dark",
  root: "sample",
  assets: "anote.assets",
  legacyAssets: ".assets",
}))

async function main() {
  const url = await server.studioLink("auth/Spec.note")
  const base = new URL(url)
  const at = (path: string) => `http://127.0.0.1:${base.port}${path}`

  console.log("\n# the link")
  check("is loopback", base.hostname === "127.0.0.1", url)
  check("is a port this run picked", Number(base.port) > 0, url)
  check("is the root, not a note's path", base.pathname === "/", base.pathname)
  check(
    "and carries the note the command was run on",
    base.searchParams.get("note") === "auth/Spec.note",
    url
  )
  check(
    "a note that climbs out of the folder is not one it opens on",
    !new URL(await server.studioLink("../../.ssh/id_rsa")).searchParams.has(
      "note"
    )
  )

  console.log("\n# the page")
  const page = await fetch(url)
  const html = await page.text()
  check("is a whole document", html.startsWith("<!doctype html>"), page.status)
  check("titles itself", html.includes("<title>ANote Studio</title>"))
  check("loads the bundle from its own origin", html.includes("/~/studio.js"))
  check(
    "points Excalidraw at the fonts this server serves",
    html.includes('window.EXCALIDRAW_ASSET_PATH = "/~/excalidraw/"')
  )
  check(
    "declares a policy that allows no other origin",
    html.includes("default-src 'none'") && html.includes("connect-src 'self'"),
    html.match(/content="default-src[^"]*/)?.[0]
  )

  const boot = JSON.parse(
    html.slice(
      html.indexOf(`id="${BOOT_ID}">`) + `id="${BOOT_ID}">`.length,
      html.indexOf("</script>", html.indexOf(`id="${BOOT_ID}">`))
    )
  ) as StudioBoot
  check("hands the page the workspace's settings", boot.pollMs === 1500, boot)
  check("and its palette", boot.theme === "dark", boot.theme)
  check("and which folder it is on", boot.root === "sample", boot.root)
  check("and a token", boot.token.length >= 32, boot.token.length)

  const token = { [TOKEN_HEADER]: boot.token }

  console.log("\n# the token, which is what makes a writable page safe")
  const noToken = await fetch(at(API.notes))
  check("no token, no notes", noToken.status === 403, noToken.status)
  const wrongToken = await fetch(at(API.notes), {
    headers: { [TOKEN_HEADER]: "0".repeat(boot.token.length) },
  })
  check("a wrong one is no better", wrongToken.status === 403, wrongToken.status)
  const shortToken = await fetch(at(API.notes), {
    headers: { [TOKEN_HEADER]: "nope" },
  })
  check("nor is a shorter one", shortToken.status === 403, shortToken.status)

  console.log("\n# what stands in front of the port")
  const named = await fetch(at("/"), { headers: { host: "evil.test" } })
  check(
    "a request addressed to another name is refused — DNS rebinding",
    named.status === 404,
    named.status
  )
  const cross = await fetch(at(API.notes), {
    headers: { ...token, "sec-fetch-site": "cross-site" },
  })
  check(
    "a fetch another site started is refused, token or no token",
    cross.status === 404,
    cross.status
  )
  const reader = await fetch(at(API.notes), {
    headers: { ...token, "sec-fetch-site": "same-origin" },
  })
  check("a reader on the page itself is not", reader.status === 200, reader.status)

  console.log("\n# the sidebar")
  const listing = (await (
    await fetch(at(API.notes), { headers: token })
  ).json()) as NotesResult
  check(
    "lists every note, by its path under the root",
    listing.notes.map((note) => note.path).join(" ") ===
      "Welcome.note auth/Spec.note",
    listing.notes
  )
  check(
    "with the name a row shows",
    listing.notes.find((note) => note.path === "auth/Spec.note")?.name === "Spec",
    listing.notes
  )

  console.log("\n# opening a note")
  const opened = (await (
    await fetch(at(`${API.note}?${PATH_PARAM}=auth/Spec.note`), {
      headers: token,
    })
  ).json()) as NoteResult
  check("hands over the text as it is on disk", opened.text === notes.get("auth/Spec.note"))
  check("and a version to save against", opened.version.length > 0, opened.version)
  check(
    "and where a picture in an older note resolves from",
    opened.dirUrl === "/files/auth",
    opened.dirUrl
  )
  check(
    "and where one in the workspace's assets directory does",
    opened.assetsUrl === "/files/anote.assets" &&
      opened.assetsDir === "anote.assets",
    `${opened.assetsUrl} ${opened.assetsDir}`
  )
  const head = await fetch(at(`${API.note}?${PATH_PARAM}=auth/Spec.note`), {
    method: "HEAD",
    headers: token,
  })
  check(
    "HEAD is the poll: the version, with nothing pulled down",
    head.headers.get("etag") === `"${opened.version}"` &&
      (await head.text()) === "",
    head.headers.get("etag")
  )
  const missing = await fetch(at(`${API.note}?${PATH_PARAM}=nope.note`), {
    headers: token,
  })
  check("a note that is not there is 404", missing.status === 404, missing.status)
  const climbing = await fetch(
    at(`${API.note}?${PATH_PARAM}=${encodeURIComponent("../../.ssh/id_rsa")}`),
    { headers: token }
  )
  check(
    "a path that climbs out is refused before anything reads it",
    climbing.status === 400,
    climbing.status
  )
  const notANote = await fetch(
    at(`${API.note}?${PATH_PARAM}=auth/passwords.txt`),
    { headers: token }
  )
  check(
    "and so is a file that is not a note",
    notANote.status === 400,
    notANote.status
  )

  console.log("\n# saving")
  const edited = JSON.stringify([
    { type: "paragraph", content: [{ type: "text", text: "typed", styles: {} }] },
  ])
  const save = await fetch(at(`${API.note}?${PATH_PARAM}=auth/Spec.note`), {
    method: "PUT",
    headers: { ...token, [VERSION_HEADER]: opened.version },
    body: edited,
  })
  const saved = (await save.json()) as SavedResult
  check("writes the note", notes.get("auth/Spec.note") === edited, save.status)
  check("byte for byte, not reserialised", notes.get("auth/Spec.note") === edited)
  check("and answers with the version it is now at", saved.version !== opened.version)

  const stale = await fetch(at(`${API.note}?${PATH_PARAM}=auth/Spec.note`), {
    method: "PUT",
    headers: { ...token, [VERSION_HEADER]: opened.version },
    body: JSON.stringify([]),
  })
  const clash = (await stale.json()) as Problem
  check(
    "a save against a version the file has moved on from is refused",
    stale.status === 409,
    stale.status
  )
  check(
    "with the version it is actually at, so the page can offer to load it",
    clash.version === saved.version,
    clash
  )
  check("and the file is untouched", notes.get("auth/Spec.note") === edited)

  const versionless = await fetch(
    at(`${API.note}?${PATH_PARAM}=auth/Spec.note`),
    { method: "PUT", headers: token, body: JSON.stringify([]) }
  )
  check(
    "a save that says nothing about what it replaces is refused outright",
    versionless.status === 428,
    versionless.status
  )

  const rubbish = await fetch(at(`${API.note}?${PATH_PARAM}=auth/Spec.note`), {
    method: "PUT",
    headers: { ...token, [VERSION_HEADER]: saved.version },
    body: "not json at all",
  })
  check(
    "and so is something that is not a note",
    rubbish.status === 400 && notes.get("auth/Spec.note") === edited,
    rubbish.status
  )

  console.log("\n# making one")
  const made = await fetch(at(API.notes), {
    method: "POST",
    headers: { ...token, "content-type": "application/json" },
    body: JSON.stringify({ path: "auth/2026/Plan.note" }),
  })
  check(
    "creates the note, directories and all",
    made.status === 201 && notes.has("auth/2026/Plan.note"),
    made.status
  )
  const again = await fetch(at(API.notes), {
    method: "POST",
    headers: { ...token, "content-type": "application/json" },
    body: JSON.stringify({ path: "auth/2026/Plan.note" }),
  })
  check(
    "and will not write over one that is already there",
    again.status === 409,
    again.status
  )

  console.log("\n# the notes' files")
  const picture = await fetch(at("/files/auth/Spec.note.assets/shape.png"))
  check("serves the picture", picture.status === 200, picture.status)
  check(
    "as what its extension says it is",
    picture.headers.get("content-type") === "image/png",
    picture.headers.get("content-type")
  )
  check(
    "and says it takes ranges, for a clip that has to be seekable",
    picture.headers.get("accept-ranges") === "bytes"
  )
  check(
    "the bytes are the file's own",
    Buffer.from(await picture.arrayBuffer()).equals(PNG)
  )
  const pooled = await fetch(
    at(`/files/anote.assets/${encodeURI("báo cáo.png")}`)
  )
  check(
    "and one in the workspace's assets directory, under its own name",
    pooled.status === 200 &&
      Buffer.from(await pooled.arrayBuffer()).equals(PNG),
    pooled.status
  )
  const loose = await fetch(at("/files/.env"))
  check(
    "a file in the folder that is inside no assets directory is not served",
    loose.status === 404,
    loose.status
  )
  const theNote = await fetch(at("/files/auth/Spec.note"))
  check("nor is a note itself", theNote.status === 404, theNote.status)

  console.log("\n# a drawing's scene, which the editor reads and writes itself")
  const scene = "eyJ0eXBlIjoiZXhjYWxpZHJhdyJ9"
  const put = await fetch(
    at(
      `${API.asset}?${PATH_PARAM}=auth/Spec.note&${FILE_PARAM}=d1d2d3d4-0000-4111-8222-333344445555.excalidraw`
    ),
    {
      method: "PUT",
      headers: { ...token, "content-type": "application/json" },
      body: JSON.stringify({ base64: scene }),
    }
  )
  check("writes it beside the note", put.status === 200, put.status)
  const read = await fetch(
    at(
      `${API.asset}?${PATH_PARAM}=auth/Spec.note&${FILE_PARAM}=d1d2d3d4-0000-4111-8222-333344445555.excalidraw`
    ),
    { headers: token }
  )
  check(
    "and reads it back",
    ((await read.json()) as { base64: string | null }).base64 === scene
  )
  const never = await fetch(
    at(`${API.asset}?${PATH_PARAM}=auth/Spec.note&${FILE_PARAM}=never-drawn.excalidraw`),
    { headers: token }
  )
  check(
    "a scene nobody has drawn in is null rather than an error",
    ((await never.json()) as { base64: string | null }).base64 === null
  )
  const escaping = await fetch(
    at(
      `${API.asset}?${PATH_PARAM}=auth/Spec.note&${FILE_PARAM}=${encodeURIComponent("../../../etc/passwd")}`
    ),
    { headers: token }
  )
  check(
    "and a name that is not one this editor writes is refused",
    escaping.status === 400,
    escaping.status
  )

  console.log("\n# a dropped picture")
  const uploaded = await fetch(
    at(`${API.upload}?${PATH_PARAM}=auth/Spec.note`),
    {
      method: "POST",
      headers: { ...token, "content-type": "application/json" },
      body: JSON.stringify({
        name: "shape.png",
        mime: "image/png",
        base64: PNG.toString("base64"),
      }),
    }
  )
  check(
    "is handed to the workspace with the note it belongs to",
    uploads[0] === `auth/Spec.note shape.png image/png ${PNG.byteLength}`,
    uploads
  )
  check(
    "and comes back as the path the document will hold",
    ((await uploaded.json()) as UploadedResult).path === "anote.assets/shape.png"
  )

  console.log("\n# the bundle")
  const script = await fetch(at("/~/studio.js"))
  check(
    "is served as script",
    script.status === 200 &&
      script.headers.get("content-type") === "text/javascript; charset=utf-8",
    script.headers.get("content-type")
  )
  check(
    "and nothing this table has no type for",
    (await fetch(at("/~/package.json"))).status === 404
  )
  /* Over a socket rather than through `fetch`, which resolves `..` in a URL before
     it ever leaves the page — so the only client that can ask this question is one
     writing the request line itself. */
  const climbed = await raw(base.port, "GET /~/../../package.json HTTP/1.1")
  check(
    "and a request line that climbs out of dist is not answered",
    !climbed.startsWith("HTTP/1.1 200"),
    climbed
  )

  console.log("\n# one origin, two surfaces")
  const asPage = await fetch(at(`/${READ}/auth/Spec.note`))
  const pageHtml = await asPage.text()
  check(
    "a note in the folder has a page without anybody registering it",
    asPage.status === 200 && pageHtml.includes("<article>"),
    asPage.status
  )
  check(
    "which is finished HTML — the words are there with no script run",
    pageHtml.includes("typed") || pageHtml.includes("<p>"),
    pageHtml.match(/<article>[\s\S]{0,60}/)?.[0]
  )
  check(
    "and it carries the Edit link back to the studio, on this same port",
    pageHtml.includes(
      '<a class="edit-link" href="/?note=auth%2FSpec.note">Edit</a>'
    ),
    pageHtml.match(/<a class="edit-link"[^>]*>[^<]*<\/a>/)?.[0]
  )
  const notThere = await fetch(at(`/${READ}/auth/Nothing.note`))
  check(
    "a path no note is at is still 404",
    notThere.status === 404,
    notThere.status
  )
  const notANotePage = await fetch(at(`/${READ}/.env`))
  check(
    "and a file in the folder that is not a note has no page",
    notANotePage.status === 404,
    notANotePage.status
  )
  const written = await fetch(at(`/${READ}/auth/Spec.note`), { method: "PUT" })
  check(
    "the page route takes no writes, token or no token",
    written.status === 405,
    written.status
  )

  console.log("\n# with no studio mounted")
  const bare = new NoteServer()
  const bareUrl = await bare.linkTo("Spec.note", {
    name: "Spec",
    text: async () => "[]",
    file: async () => null,
    has: async () => false,
    drawingSvg: async () => "",
  })
  const barePort = new URL(bareUrl).port
  const atBare = (path: string) => `http://127.0.0.1:${barePort}${path}`
  check(
    "the pages still work — a workspace can serve them with the studio off",
    (await fetch(bareUrl)).status === 200
  )
  for (const [what, path] of [
    ["the studio's document", "/"],
    ["the API", API.notes],
    ["a note's files", "/files/Spec.note.assets/x.png"],
    ["the bundle", "/~/studio.js"],
  ] as const) {
    const answer = await fetch(atBare(path))
    check(`${what} is not there at all`, answer.status === 404, answer.status)
  }
  bare.dispose()

  console.log("\n# shutting down")
  server.dispose()
  const gone = await fetch(url).catch(() => null)
  check("the port is gone with it", gone === null)

  console.log(
    failures === 0
      ? "\n✓ all checks passed"
      : `\n✗ ${failures} check${failures === 1 ? "" : "s"} failed`
  )
  process.exit(failures === 0 ? 0 : 1)
}

/** One request, written onto the socket by hand — the status line comes back.
 * `fetch` is the wrong tool for a request that is deliberately not well formed. */
function raw(port: string | number, line: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(Number(port), "127.0.0.1", () => {
      socket.write(`${line}\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`)
    })
    let answer = ""
    socket.on("data", (chunk) => (answer += chunk.toString("utf8")))
    socket.on("end", () => resolve(answer.split("\r\n")[0] ?? ""))
    socket.on("error", reject)
  })
}

void main()
