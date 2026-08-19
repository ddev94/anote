import { NoteServer } from "../src/host/note-server"
import type { NoteSource } from "../src/host/preview-pages"
import type { NoteBlock } from "../src/protocol"

/**
 * A note as a page, fetched over a real socket from a real server.
 *
 * Half of what the port answers for — `test/studio-routes.ts` is the other half, and
 * the two bind the same `NoteServer` because there is one of it. The checks that
 * matter are the seams: the registry that decides which notes have a page at all,
 * the path that is a key and never a filename, the escaping in the markup, and now
 * the **Edit** link, which must be there exactly when there is a studio to send
 * somebody to.
 *
 * It runs here at all because nothing under `src/host/` on this path imports
 * `vscode`: what the server needs of a note arrives as functions, so a test can be
 * the thing that supplies them. That is the same reason the app's own server takes a
 * `NoteSource`.
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

/** A "video", long enough that a middle slice of it can be asked for. Its bytes
 * being nonsense is the point: nothing here decodes them, and what is under test is
 * which bytes come back. */
const CLIP = Buffer.from("a video, as far as this test is concerned")

const DRAWN = "d1d2d3d4-0000-4111-8222-333344445555"

const BLOCKS: NoteBlock[] = [
  {
    type: "heading",
    props: { level: 2 },
    content: [{ type: "text", text: "Endpoints", styles: {} }],
  },
  {
    type: "paragraph",
    content: [
      { type: "text", text: "Send ", styles: { bold: true } },
      { type: "text", text: "POST", styles: { code: true } },
    ],
  },
  // A picture the note holds, which has to arrive as bytes: this page goes to a
  // browser that cannot read the workspace.
  {
    type: "image",
    props: { url: "Spec.note.assets/shape.png", name: "shape" },
  },
  // One whose file has gone.
  {
    type: "image",
    props: { url: "Spec.note.assets/gone.png", caption: "gone" },
  },
  // A clip, which cannot be inlined: `<video>` cannot seek inside a `data:` URL,
  // so this has to become a link back to the server.
  {
    type: "video",
    props: { url: "Spec.note.assets/demo.mp4", name: "demo.mp4" },
  },
  // And one whose file has gone, which stays a "missing" line rather than a
  // player pointed at a 404.
  {
    type: "video",
    props: { url: "Spec.note.assets/vanished.mp4", caption: "vanished" },
  },
  // A drawing, which the page can only show as the picture exported beside its
  // scene: nothing on this side of the extension can run Excalidraw.
  { type: "drawing", props: { drawingId: DRAWN } },
  // And one whose scene has never been saved, so nothing was ever exported.
  { type: "drawing", props: { drawingId: "never-saved" } },
  // The one block whose text must not become markup.
  {
    type: "paragraph",
    content: [{ type: "text", text: "<script>alert(1)</script>", styles: {} }],
  },
]

let text = JSON.stringify(BLOCKS)
let reads = 0

const FILES: Record<string, Buffer> = {
  "Spec.note.assets/shape.png": PNG,
  "Spec.note.assets/demo.mp4": CLIP,
}

const source: NoteSource = {
  name: "Spec",
  text: async () => {
    reads += 1
    return text
  },
  file: async (relative) => FILES[relative] ?? null,
  has: async (relative) => relative in FILES,
  drawingSvg: async (id) =>
    id === DRAWN
      ? '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>'
      : "",
}

const server = new NoteServer()

async function main() {
  const NOTE_PATH = "auth/Spec.note"
  const url = await server.linkTo(NOTE_PATH, source)
  const base = new URL(url)

  console.log("\n# the link")
  check("is loopback", base.hostname === "127.0.0.1", url)
  check("is a port this run picked", Number(base.port) > 0, url)
  check(
    "is the note's own path in the workspace, under the read prefix",
    base.pathname === `/read/${NOTE_PATH}`,
    base.pathname
  )
  check(
    "asking twice gives the same link",
    (await server.linkTo(NOTE_PATH, source)) === url
  )
  check(
    "a path with a leading slash is the same path",
    (await server.linkTo(`/${NOTE_PATH}`, source)) === url
  )

  const at = (path: string) => `http://127.0.0.1:${base.port}${path}`
  /** The note's own URL, as the routes spell it. */
  const READ_PATH = `/read/${NOTE_PATH}`

  console.log("\n# what is served")
  const response = await fetch(url)
  const html = await response.text()
  check("answers the note", response.status === 200, response.status)
  check("is a whole document", html.startsWith("<!doctype html>"))
  check("titles it with the note's name", html.includes("<title>Spec</title>"))
  check("renders the blocks", html.includes("<h2>Endpoints</h2>"))
  check(
    "inlines a picture the note holds",
    html.includes(`<img src="data:image/png;base64,${PNG.toString("base64")}"`),
    html.match(/<img[^>]*>/)?.[0]
  )
  check(
    "says so for one whose file has gone, rather than a broken image",
    !html.includes("gone.png") && html.includes('<p class="missing">gone</p>'),
    html.match(/[^"]*gone[^"]*/)?.[0]
  )
  check(
    "inlines the picture a drawing was exported as",
    html.includes('<figure class="drawing"><svg viewBox="0 0 10 10">'),
    html.match(/<figure class="drawing">[\s\S]{0,80}/)?.[0]
  )
  check(
    "and says so for a drawing that was never saved",
    (html.match(/class="missing">Drawing/g) ?? []).length === 1,
    html.match(/class="missing">Drawing[^<]*/g)?.join(" | ")
  )
  check(
    "escapes the note's own markup",
    html.includes("&lt;script&gt;alert(1)&lt;/script&gt;") &&
      !html.includes("<script>alert(1)</script>")
  )
  check(
    "carries the poll that keeps a browser tab in step",
    html.includes("setInterval") && html.includes('method: "HEAD"')
  )
  check(
    "and is not cached — a cached preview is the note as it was",
    response.headers.get("cache-control") === "no-store"
  )

  console.log("\n# light and dark, in a browser")
  check(
    "the page is served with no opinion and switched in the tab",
    html.includes('<html lang="en" data-theme="auto">') &&
      html.includes('<button class="theme-switch" type="button">'),
    html.match(/<html[^>]*>/)?.[0]
  )
  check(
    "the choice is applied in the head, before anything is painted",
    html.indexOf("localStorage.getItem") < html.indexOf("</head>") &&
      html.indexOf("localStorage.getItem") > 0
  )
  check(
    "it is remembered per browser rather than known to the server",
    html.includes('"anote.preview.theme"') &&
      html.includes("localStorage.setItem"),
    html.match(/localStorage\.\w+\([^)]*\)/g)?.join(" ")
  )
  check(
    "and the button is not printed with the note",
    html.includes("@media print { .theme-switch { display: none; } }")
  )

  console.log("\n# video and audio")
  const clipUrl = `${READ_PATH}?file=${encodeURIComponent("Spec.note.assets/demo.mp4")}`
  check(
    "a clip is a player pointed at this server, not inlined",
    html.includes(`<video controls preload="metadata" src="${clipUrl}">`) &&
      !html.includes("data:video"),
    html.match(/<video[^>]*>/)?.[0]
  )
  check(
    "one whose file has gone stays a line saying so",
    !html.includes("vanished.mp4") &&
      html.includes('<p class="missing">vanished</p>'),
    html.match(/[^"]*vanished[^"]*/)?.[0]
  )

  const clip = await fetch(at(clipUrl))
  check("the route serves it", clip.status === 200, clip.status)
  check(
    "as what its extension says it is",
    clip.headers.get("content-type") === "video/mp4",
    clip.headers.get("content-type")
  )
  check(
    "and says it takes ranges — a player that cannot seek is the failure here",
    clip.headers.get("accept-ranges") === "bytes"
  )
  check("the bytes are the file's own", (await clip.text()) === CLIP.toString())

  const ranged = await fetch(at(clipUrl), { headers: { range: "bytes=2-6" } })
  check("answers a range with 206", ranged.status === 206, ranged.status)
  check(
    "says which bytes those were",
    ranged.headers.get("content-range") === `bytes 2-6/${CLIP.byteLength}`,
    ranged.headers.get("content-range")
  )
  check(
    "and sends exactly them",
    (await ranged.text()) === CLIP.subarray(2, 7).toString()
  )
  const suffix = await fetch(at(clipUrl), { headers: { range: "bytes=-4" } })
  check(
    "a suffix range is the end of the file",
    suffix.status === 206 &&
      (await suffix.text()) === CLIP.subarray(-4).toString()
  )
  const past = await fetch(at(clipUrl), { headers: { range: "bytes=9999-" } })
  check(
    "a range past the end is 416",
    past.status === 416 &&
      past.headers.get("content-range") === `bytes */${CLIP.byteLength}`,
    past.status
  )
  const strayFile = await fetch(
    at(`${READ_PATH}?file=${encodeURIComponent("Spec.note.assets/nope.mp4")}`)
  )
  check(
    "a file this note does not have is not found",
    strayFile.status === 404,
    strayFile.status
  )
  const climbing = await fetch(
    at(`${READ_PATH}?file=${encodeURIComponent("../../etc/passwd")}`)
  )
  check(
    "and one climbing out of the note's directory is refused",
    climbing.status === 404,
    climbing.status
  )

  console.log("\n# what is not served")
  /* The registry is the whole of it now that the path is guessable: a note reaches
     it by somebody asking for a link and no other way. */
  const stray = await fetch(at("/read/auth/NeverLinked.note"))
  check(
    "a note this server was never asked for is not found",
    stray.status === 404,
    stray.status
  )
  const root = await fetch(at("/"))
  check(
    "nor is the root, with no studio mounted on this server",
    root.status === 404,
    root.status
  )
  const traversal = await fetch(at("/read/..%2F..%2Fetc%2Fpasswd"))
  check(
    "nor is a path that climbs out",
    traversal.status === 404,
    traversal.status
  )
  const deeper = await fetch(at(`${READ_PATH}/and-more`))
  check(
    "nor is a longer path than the note's",
    deeper.status === 404,
    deeper.status
  )
  const posted = await fetch(url, { method: "POST" })
  check("and it will not answer a POST", posted.status === 405, posted.status)

  console.log("\n# what stands in for the secret")
  const rebound = await fetch(url, { headers: { host: "evil.test" } })
  check(
    "a request addressed to another name is refused — DNS rebinding",
    rebound.status === 404,
    rebound.status
  )
  const named = await fetch(url, { headers: { host: `localhost:${base.port}` } })
  check(
    "but localhost is this interface by another name",
    named.status === 200,
    named.status
  )
  const foreign = await fetch(url, {
    headers: { "sec-fetch-site": "cross-site" },
  })
  check(
    "a fetch another site started is refused",
    foreign.status === 404,
    foreign.status
  )
  const sameSite = await fetch(url, { headers: { "sec-fetch-site": "none" } })
  check(
    "a reader opening it themselves is not",
    sameSite.status === 200,
    sameSite.status
  )
  const elsewhere = await fetch(url, {
    headers: { origin: "http://evil.test" },
  })
  check(
    "and so is one carrying another origin",
    elsewhere.status === 404,
    elsewhere.status
  )

  console.log("\n# the way over to editing it")
  check(
    "no studio on this server, so the page offers no Edit link",
    !html.includes('class="edit-link"'),
    html.match(/<a class="edit-link"[^>]*>/)?.[0]
  )
  const editable = await server.linkTo("auth/Editable.note", {
    ...source,
    studioPath: "Editable.note",
  })
  const withoutStudio = await (await fetch(editable)).text()
  check(
    "and neither does one whose note the studio could address, while there is none",
    !withoutStudio.includes('class="edit-link"')
  )

  console.log("\n# the reload poll")
  const head = await fetch(url, { method: "HEAD" })
  const etag = head.headers.get("etag") ?? ""
  check("HEAD carries the version", etag.length > 2, etag)
  check("HEAD carries no body", (await head.text()) === "")
  check(
    "the page holds the version it was rendered at",
    html.includes(`<meta name="version" content="${etag.replace(/"/g, "")}">`),
    etag
  )

  text = JSON.stringify([
    { type: "paragraph", content: [{ type: "text", text: "changed" }] },
  ])
  const after = await fetch(url, { method: "HEAD" })
  check(
    "and the version follows the note",
    after.headers.get("etag") !== etag,
    after.headers.get("etag")
  )
  /* Six: the page, the two pages the host and `Sec-Fetch-Site` checks let through,
     the one the Edit-link check fetched, and the two HEADs.
     The note is asked for once per request it answers and never held — nothing above
     this line came out of a cache, which is what makes the poll's ETag mean
     anything. The refused requests are not in the count, which is the other half of
     it: a request that is not answered is not a read. */
  check(
    "which is read through the caller once per page, and never cached",
    reads === 6,
    reads
  )

  console.log("\n# shutting down")
  server.dispose()
  const afterStop = await fetch(url).catch(() => null)
  check("the port is gone with it", afterStop === null)

  console.log(
    failures === 0
      ? `\n✓ all checks passed\n`
      : `\n✗ ${failures} check${failures === 1 ? "" : "s"} failed\n`
  )
  process.exit(failures === 0 ? 0 : 1)
}

await main()
