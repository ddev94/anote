import type { IncomingMessage, ServerResponse } from "node:http"

import { isBeside, send, sendFile, versionOf } from "./http"
import { drawingIdsIn, parseNote } from "./note-blocks"
import { contentTypeOf } from "./note-files"
import { page, renderNote } from "./note-html"
import type { AnoteConfig } from "../config"
import type { NoteBlock } from "../protocol"

/**
 * A note as a page in the reader's own browser — the half of the loopback server
 * that answers `/read/<the note's path>`.
 *
 * The other preview in this extension is a webview beside the editor. This one is
 * for the thing a webview cannot be: a note open in Chrome next to whatever it
 * documents, or handed to something that fetches pages rather than looks at them.
 * It is the app's `main/preview.ts` in a different host — the file that made the
 * point about 20 of 30 main-process modules being portable — and the interesting
 * parts are the ones that are not about Electron:
 *
 * - **The note's own path in the workspace, as the URL's path.**
 *   `/read/auth/login.note`, so a copied link says which note it is. There used to
 *   be a secret in front of it; `note-server.ts` has what replaced it and why a
 *   path cannot do that job.
 * - **Finished HTML.** No script is needed to put the words on the page — which is
 *   the whole reason this exists alongside the studio, where the note is drawn by
 *   an editor. `curl` reads this one.
 * - **The document never writes the markup.** Everything here came off disk, so
 *   text is escaped, a URL is checked against a scheme list, and a `.svg` that is
 *   not an SVG is not inlined.
 *
 * **It no longer owns a socket.** It used to be a server of its own on a port of its
 * own; there is one port now and `note-server.ts` owns it, so what is left in this
 * file is the page and the one route that serves a file beside a note. The reasoning
 * for merging the two — and what it cost — is at the top of that file.
 *
 * It imports no `vscode`. What it needs of a note arrives as the functions in
 * `NoteSource`, the way the app's own server takes one rather than importing its
 * store.
 */

/**
 * What the server is given for each note it will answer for.
 *
 * Functions rather than a URI, because "the note as it is right now" is a question
 * only the caller can answer — the open editor if there is one, the file if not,
 * and on a remote neither is something `node:fs` can reach.
 */
export type NoteSource = {
  /** For the page's title. */
  name: string
  text: () => Promise<string>
  /** Any file stored beside the note, by the relative path the document holds, or
   * null for one whose file has gone. */
  file: (relative: string) => Promise<Uint8Array | null>
  /** Whether that file is there, asked without reading it — a video is fetched on
   * a request of its own, so the page only needs to know it exists to put a player
   * around it. Reading a 200MB clip to render a page would not do. */
  has: (relative: string) => Promise<boolean>
  /** A drawing's last export, by id, or "" for a scene never saved. Inlined into
   * the page: this side has no Excalidraw, and turning a scene into a picture
   * needs a canvas and a font stack. */
  drawingSvg: (id: string) => Promise<string>
  /**
   * The path the studio addresses this same note by, if it can — which is what puts
   * the **Edit** link on the page.
   *
   * Optional, and the two ways it is absent are both real: a workspace that has
   * turned the studio off, and a note outside the notes root, which the studio's
   * sidebar cannot list and so has no business opening. It is the caller's to
   * supply because only the caller knows both names for one file — the page's key is
   * the note's path in the *workspace*, the studio's is its path under `notesDir`,
   * and nothing here could turn one into the other.
   */
  studioPath?: string
}

/**
 * What makes a URL one of a note's files rather than the note.
 *
 * A query parameter and no longer a path segment, and the note's path is why. It
 * used to be the segment after the note's id — safe as a reserved word because the
 * id was made up, so the space it reserved was one nothing else was using. A note
 * is addressed by its path in the workspace now, and a workspace is allowed a
 * directory called `file`; `?file=` cannot collide with one.
 */
const FILE_PARAM = "file"

/* The interface, the two checks that guard it, the range slicing and the
   ETag are all in `http.ts` now — the studio server binds a port on the same
   machine for the same notes, and those are the parts of both that must not
   drift apart. What is left in this file is the preview itself. */

/** Where the reader's light/dark choice is kept in their browser. Namespaced,
 * because the origin is a loopback port and everything else that ever binds one
 * shares it. */
const THEME_KEY = "anote.preview.theme"

/** What the pages take out of `anote.config.json` — see `src/config.ts`. The
 * palette a page starts on, and how often it asks whether the note changed. */
export type PreviewSettings = AnoteConfig["preview"]

/**
 * The note, as whatever the request asked for: the page, its version, or one of the
 * files beside it.
 *
 * The whole of the old server's request handler from the lookup onwards — the
 * caller has already decided that this request is for this note, which is the part
 * that moved. `edit` is the studio's URL for the same note, or null when there is
 * no studio to send anybody to; see `withEditLink`.
 */
export async function previewNote(
  request: IncomingMessage,
  response: ServerResponse,
  note: NoteSource,
  asked: URL,
  settings: PreviewSettings,
  edit: string | null
): Promise<void> {
  const file = asked.searchParams.get(FILE_PARAM)
  if (file !== null) {
    return await serveFileBeside(request, response, note, file)
  }

  const text = await note.text()
  const version = versionOf(text)

  // What the page's own poll asks for: the headers, so the ETag can be compared
  // without pulling the note down every two seconds.
  if (request.method === "HEAD") {
    return send(request, response, 200, "", version)
  }

  const blocks = parseNote(text)
  const [document, drawings] = await Promise.all([
    resolved(blocks, note, asked.pathname),
    drawingsIn(blocks, note),
  ])

  /*
   * Rendered at the workspace's palette and switched in the page, which is the
   * opposite of what the webview preview does — and for the reason the poll exists:
   * a browser is somewhere a script runs, so the reader gets a control rather than a
   * command, and the server never has to know which of them chose what.
   * `preview.theme` is only where the page starts: a reader who has pressed the
   * button has that in `localStorage`, and the script in the head applies it before
   * the first paint.
   */
  const html = withEditLink(
    withThemeSwitch(
      withReloadPoll(
        page(
          note.name,
          version,
          /* No heading of the note's own name — see the same call in `preview.ts`.
             Here the name is the browser's tab. */
          `<article>${renderNote(document, drawings)}</article>`,
          settings.theme
        ),
        settings.pollMs
      )
    ),
    edit
  )
  send(request, response, 200, html, version)
}

/**
 * The document, with every file beside the note turned into something the browser
 * can fetch. Two answers, and the split is the interesting decision on this page:
 *
 * - **A picture is inlined**, as a `data:` URL. It is small, and it is what keeps a
 *   note of writing and screenshots a single file — saveable out of the browser,
 *   mailable, readable by something that follows no links.
 * - **Everything else is a link back to this server.** A `data:` URL is the wrong
 *   shape for a clip: `<video>` cannot seek inside one, the base64 is a third
 *   bigger than the bytes, and a browser refuses to navigate to a `data:` document
 *   at all — which is what left a PDF in a note unopenable and a video showing the
 *   "missing" line where a player should be.
 *
 * A file that is not there is left as the relative path it was, which `safeUrl`
 * refuses — so the page says what it was rather than emitting a `src` that 404s.
 */
async function resolved(
  blocks: NoteBlock[],
  note: NoteSource,
  base: string
): Promise<NoteBlock[]> {
  return Promise.all(
    blocks.map(async (block) => {
      const children = block.children
        ? await resolved(block.children, note, base)
        : block.children
      const keep = () =>
        children === block.children ? block : { ...block, children }

      const url = block.props?.url
      if (typeof url !== "string" || !isBeside(url)) return keep()

      const type = contentTypeOf(url)
      if (type?.startsWith("image/")) {
        const bytes = await note.file(url).catch(() => null)
        if (!bytes) return keep()
        return {
          ...block,
          props: {
            ...block.props,
            url: `data:${type};base64,${Buffer.from(bytes).toString("base64")}`,
          },
          ...(children ? { children } : {}),
        }
      }

      if (!(await note.has(url).catch(() => false))) return keep()
      return {
        ...block,
        props: {
          ...block.props,
          url: `${base}?${FILE_PARAM}=${encodeURIComponent(url)}`,
        },
        ...(children ? { children } : {}),
      }
    })
  )
}

/**
 * One of the note's own files, on a request of its own.
 *
 * Range requests are answered because that is what a media element does: a
 * `<video>` asks for the head of the file to find its duration and then for the
 * bytes around wherever the reader drags to. A server that answers every one of
 * those with the whole file gives a player that cannot be seeked — and, for a large
 * clip, one that will not start.
 *
 * Sliced out of the bytes in hand rather than streamed off disk. That is honest only
 * because a note's files are what somebody dropped into a note; a note that could
 * hold an hour of video would want a read stream here.
 */
async function serveFileBeside(
  request: IncomingMessage,
  response: ServerResponse,
  note: NoteSource,
  name: string
): Promise<void> {
  if (!isBeside(name)) return send(request, response, 404, "Not found")

  const bytes = await note.file(name).catch(() => null)
  if (!bytes) return send(request, response, 404, "Not found")

  /*
   * The type comes off the name through the shared table and from nowhere else —
   * never sniffed, never from the request. An extension the table has no entry for
   * is served as bytes, which with `nosniff` is a download rather than a document.
   * That, and the split in `resolved` above, is what keeps this route from serving
   * anything scriptable on the preview's own origin: the only entry in the table a
   * browser would run script from is `image/svg+xml`, and an SVG is a picture, so it
   * is inlined into the page and never arrives here.
   */
  sendFile(
    request,
    response,
    name,
    bytes,
    contentTypeOf(name) ?? "application/octet-stream"
  )
}

/** The picture each drawing was last exported as, by id. Only what this app
 * exported: the file is one of ours, but it is going into a page, and a `.svg`
 * that is not an SVG is markup straight into the document. */
async function drawingsIn(
  blocks: NoteBlock[],
  note: NoteSource
): Promise<Map<string, string>> {
  const drawings = new Map<string, string>()

  await Promise.all(
    drawingIdsIn(blocks).map(async (id) => {
      const svg = await note.drawingSvg(id).catch(() => "")
      if (svg.trimStart().startsWith("<svg")) drawings.set(id, svg)
    })
  )
  return drawings
}

/**
 * The way from reading a note to editing it: one link, to the same port.
 *
 * The pair to the studio's own "Open as page", and the reason the two surfaces are
 * on one origin at all — a reader who has followed a link to a note and wants to fix
 * a line should not have to go and find VS Code. It is a plain `<a>` and not a
 * script: this page is finished HTML, and adding the first piece of behaviour it
 * cannot do without would be giving that up for a button.
 *
 * Absent, and correctly so, when there is no studio mounted for this note — the
 * workspace turned it off, or the note is one the studio cannot address. A button
 * that leads to a 404 is worse than no button.
 */
function withEditLink(html: string, edit: string | null): string {
  if (!edit) return html

  const control = `<style>
/* Beside the theme switch, sharing its shape: they are the page's only two
   controls and they are the same kind of thing — something the reader may press,
   as opposed to the note. The switch is at 0.85rem from the right; this sits
   inboard of it. */
.edit-link { position: fixed; top: 0.85rem; right: 5.6rem; z-index: 2;
  font: inherit; font-size: 0.75rem; line-height: 1; letter-spacing: 0.02em;
  padding: 0.45rem 0.75rem; border: 1px solid var(--line); border-radius: 999px;
  background: var(--paper); color: var(--dim); text-decoration: none; }
.edit-link:hover { color: var(--ink); }
/* The first block already leaves room for the switch; this needs a little more. */
article > :first-child { padding-right: 11rem; }
@media print { .edit-link { display: none; } }
</style>
<a class="edit-link" href="${escapeAttribute(edit)}">Edit</a>`

  return html.replace("</body>", `${control}\n</body>`)
}

/**
 * A URL, safe to spend as an attribute value.
 *
 * The URL is this server's own — `/?note=<path>` — but the path in it came off a
 * filesystem, and a filename holding a quote would otherwise end the attribute. The
 * renderer escapes everything it emits for the same reason; this string does not go
 * through it.
 */
function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

/**
 * The reload poll, put back.
 *
 * It is in the app's `page()` and was dropped from the copy of it in this
 * extension, because a webview is pushed — and then this file needed it again: a
 * browser has no channel to be told the note changed. So it is injected here,
 * where the page being served over a socket is the reason for it, rather than in
 * the shared renderer where it was wrong half the time.
 *
 * The page is complete without it. This is the only script on it, and all it does
 * is compare the ETag it was rendered at.
 */
function withReloadPoll(html: string, pollMs: number): string {
  const script = `<script>
(function () {
  var tag = document.querySelector("meta[name=version]")
  if (!tag) return
  var seen = tag.content
  setInterval(function () {
    fetch(location.href, { method: "HEAD", cache: "no-store" })
      .then(function (response) {
        var now = (response.headers.get("etag") || "").replace(/"/g, "")
        if (response.ok && now && now !== seen) location.reload()
      })
      .catch(function () {})
  }, ${Number(pollMs)})
})()
</script>`
  return html.replace("</body>", `${script}\n</body>`)
}

/**
 * The light/dark control, which only this preview can have.
 *
 * The page itself is rendered `auto` and knows nothing about a reader's choice —
 * see `page()` in `note-html.ts`, where `data-theme` on `<html>` is the whole of
 * the mechanism. Here that attribute is written twice: once in the head, before
 * anything is painted, so a reader who asked for dark does not get a white page
 * first; and again on every click of the button.
 *
 * **Why this is not in the shared renderer.** The other preview is a webview with
 * `enableScripts` off, so a button there would be a button that does nothing —
 * it toggles by re-rendering from the extension host instead. This is the same
 * split the reload poll above is on, and for the same reason: what a page served
 * over a socket can do is not what a webview can, so the difference lives in the
 * file that serves it rather than in the one that renders it.
 *
 * The choice is kept in `localStorage`, which on this server is scoped to
 * `127.0.0.1:<port>` — and the port is whatever the OS handed out this run. So it
 * survives a reload and the two-second poll, and does not survive the window,
 * which is exactly as long as the link itself lasts.
 */
function withThemeSwitch(html: string): string {
  const early = `<script>
(function () {
  try {
    var saved = localStorage.getItem(${JSON.stringify(THEME_KEY)})
    if (saved === "light" || saved === "dark" || saved === "auto")
      document.documentElement.dataset.theme = saved
  } catch (error) {
    // Storage refused — a private window, or third-party storage blocked. The
    // page is still readable in whichever theme the browser is in.
  }
})()
</script>`

  const control = `<style>
/* Out of the flow, so it does not move the note by a pixel — and out of the way
   of the note's first block, which is the one thing it would otherwise sit on top
   of. Fixed rather than absolute, so it can reach any block once the page has been
   scrolled; the first is the one it is guaranteed to overlap, and the only one
   this page knows anything about. */
.theme-switch { position: fixed; top: 0.85rem; right: 0.85rem; z-index: 2; cursor: pointer;
  font: inherit; font-size: 0.75rem; line-height: 1; letter-spacing: 0.02em;
  padding: 0.45rem 0.75rem; border: 1px solid var(--line); border-radius: 999px;
  background: var(--paper); color: var(--dim); }
.theme-switch:hover { color: var(--ink); }
article > :first-child { padding-right: 6rem; }
/* A printed note has one theme and no buttons in it. */
@media print { .theme-switch { display: none; } }
</style>
<button class="theme-switch" type="button">Auto</button>
<script>
(function () {
  var next = { auto: "light", light: "dark", dark: "auto" }
  var label = { auto: "Auto", light: "Light", dark: "Dark" }
  var root = document.documentElement
  var button = document.querySelector(".theme-switch")
  if (!button) return

  function show() {
    var now = next[root.dataset.theme] ? root.dataset.theme : "auto"
    button.textContent = label[now]
    button.title =
      now === "auto"
        ? "Following your browser — click for " + label[next[now]].toLowerCase()
        : "Always " + label[now].toLowerCase() + " — click for " + label[next[now]].toLowerCase()
  }

  button.addEventListener("click", function () {
    var now = next[root.dataset.theme] ? root.dataset.theme : "auto"
    root.dataset.theme = next[now]
    try {
      localStorage.setItem(${JSON.stringify(THEME_KEY)}, next[now])
    } catch (error) {
      // The switch still works for this page; it just will not be remembered.
    }
    show()
  })

  show()
})()
</script>`

  return html
    .replace("</head>", `${early}\n</head>`)
    .replace("</body>", `${control}\n</body>`)
}


