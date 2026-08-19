/**
 * The contract between the loopback server and the studio's page — the one thing
 * both sides read, and the only thing that crosses between them.
 *
 * The same rule `src/protocol.ts` keeps for the extension host and its webview,
 * with the transport swapped again: there a message is `postMessage`, here it is a
 * request over a loopback socket. Writing the routes and the header names down in
 * one file is what stops the page and the server from disagreeing about a spelling
 * that neither compiler would ever check.
 *
 * Types and constants only. Nothing here runs, so it can be imported by the
 * server (Node, in the extension host) and by the page (a browser bundle) without
 * either dragging the other's world along.
 */

/**
 * Where a note is served as a *page* — `/read/auth/login.note`, the finished HTML
 * that needs no script (`host/preview-pages.ts`).
 *
 * A prefix, and it did not use to need one: the preview had a port to itself and a
 * note's path was the whole of the URL. There is one port now, so a note called
 * `files/Notes.note` would have collided with the route below it — and a namespace
 * that only works until somebody names a directory `files` is not one. Both pages
 * build this URL, which is why it is here rather than in either of them.
 */
export const READ = "read"

/** Where the studio's own bundle is served from — `/~/studio.js`, `/~/studio.css`
 * and Excalidraw's fonts under `/~/excalidraw/`. A prefix a note's path cannot
 * collide with: `~` is not a name anybody's notes folder uses, and unlike a word
 * like `assets` it will not one day be a directory somebody made. */
export const BUNDLE = "~"

/** Where a note's files are served from, mounted at the notes root: a picture
 * dropped into `auth/Spec.note` is fetched from `/files/anote.assets/<file>`, and
 * one in a note written before that directory existed from
 * `/files/auth/Spec.note.assets/<file>`. It has to be a path rather than a query
 * parameter because the editor resolves a relative URL against it — see
 * `resolveFileUrl` in `src/webview/editor.tsx`. */
export const FILES = "files"

/** The JSON routes. Everything under `/api/` carries the token below; nothing
 * else can, because a `<img src>` has no headers. */
export const API = {
  /** GET: every note under the notes root. POST: create one. */
  notes: "/api/notes",
  /** GET one note's text, HEAD for just its version, PUT to save it. */
  note: "/api/note",
  /** GET and PUT a file beside a note, as base64 — a drawing's scene, and the
   * picture exported from it. Pictures the *page* displays go through `FILES`
   * instead; this route is for the bytes the editor reads and writes itself. */
  asset: "/api/asset",
  /** POST a dropped or pasted file, which the server names and files beside the
   * note. */
  upload: "/api/upload",
} as const

/**
 * The header every `/api/` request must carry, and the reason the studio may
 * write where the preview may only read.
 *
 * The preview server stops at two checks — the `Host` it arrived with, and the
 * `Sec-Fetch-Site` the browser stamped on it (`host/http.ts`) — and for a read
 * that is enough: anything on this machine that could forge them could read the
 * `.note` off disk instead. The studio saves files, so the same reasoning does not
 * carry: a page in a browser cannot read the workspace, but it can be made to
 * POST to a loopback port, and *that* is a capability it does not otherwise have.
 *
 * A token in a header is what closes it, and specifically a header rather than a
 * cookie or a query parameter:
 *
 * - The value is minted per run and handed only to the page the server itself
 *   served, in a `<script type="application/json">` a cross-origin page cannot
 *   read back.
 * - A custom header makes any cross-origin request a *preflighted* one. This
 *   server answers no `OPTIONS` and sends no CORS headers at all, so the browser
 *   refuses the real request before it is ever sent.
 * - It is not a cookie, so it is not attached to requests the page did not make on
 *   purpose, which is the failure mode CSRF is named after.
 */
export const TOKEN_HEADER = "x-anote-studio"

/**
 * The version a save was written against — the ETag the page was handed when it
 * loaded the note.
 *
 * `If-Match` would be the spelled-out HTTP way to say this and is deliberately not
 * used: `fetch` sends `If-Match` on a request the browser may also revalidate on
 * its own, and a 412 from a cache layer would be indistinguishable from the answer
 * that matters here. A header of ours means what this server says it means.
 */
export const VERSION_HEADER = "x-anote-version"

/** One note in the sidebar. `path` is what every route above addresses it by —
 * its path under the notes root, POSIX, `auth/Spec.note`. */
export type NoteEntry = {
  path: string
  /** The filename with `.note` taken off — what the sidebar and the tab show. */
  name: string
}

/** `GET /api/notes`. Sorted by path, so the tree the page builds is stable
 * between polls rather than in whatever order the filesystem answered. */
export type NotesResult = { notes: NoteEntry[] }

/** `GET /api/note`. Everything the editor needs to draw the note and nothing
 * more — the same list `init` carries over the webview's channel. */
export type NoteResult = {
  path: string
  name: string
  /** The document's text: a JSON array of blocks, or "" for a note nobody has
   * typed into. */
  text: string
  /** What a save has to be written against, and what the poll compares. */
  version: string
  /** The note's own directory, as a URL this page may fetch from — the studio's
   * answer to the `dirUri` the webview gets from `asWebviewUri`, and what a note
   * written before the shared assets directory resolves its pictures against. */
  dirUrl: string
  /** The workspace's assets directory, as a URL this page may fetch from. Where a
   * file dropped into any note in the folder goes. */
  assetsUrl: string
  /** What that directory is called — `assets.dir`. The prefix a path stored in it
   * carries, and so how the editor tells the two URLs above apart. */
  assetsDir: string
}

/** `PUT /api/note`. The version the file is now at, which the page keeps for its
 * next save. */
export type SavedResult = { version: string }

/** `POST /api/upload`, and the shape a `writeAsset` body takes as well: base64,
 * for the reason the webview's protocol gives — a request body could carry bytes,
 * but then the editor's two file calls would have two shapes for no gain. */
export type UploadRequest = { name: string; mime: string; base64: string }

/** `POST /api/upload`. The path relative to the note that the document will
 * hold. */
export type UploadedResult = { path: string }

/** `GET /api/asset`. `base64` is null for a file that is not there — a drawing
 * nobody has drawn in yet, in practice. */
export type AssetResult = { base64: string | null }

/** `PUT /api/asset`. */
export type AssetRequest = { base64: string }

/** `POST /api/notes`. A path under the notes root, ending in `.note`; the server
 * makes the directories on the way to it. */
export type CreateRequest = { path: string }

/** Every failure any route above answers with. One shape, so the page has one
 * thing to show and never has to guess whether a body is JSON. */
export type Problem = {
  /** Written to be read by whoever is looking at the studio — it is the answer,
   * not a stack trace. `Refused` in the MCP server's `workspace.ts` is the same
   * idea in the same words. */
  problem: string
  /** On a 409 from a save: the version the file is actually at, so the page can
   * offer to load it rather than only refusing. */
  version?: string
}

/**
 * What the page is handed by the document that loaded it, rather than having to
 * ask for.
 *
 * Inlined into the HTML as JSON because two of the four are needed before the
 * first fetch can be made — the token, or every request is refused — and because
 * a page that has to round-trip for its own settings paints twice.
 */
export type StudioBoot = {
  token: string
  /** The note to open, if the command that opened the studio had one in front of
   * it, or the reader came back to a URL with `?note=` on it. */
  note: string | null
  /** `preview.pollMs` — how often the studio asks whether the note it has open
   * changed underneath it. The same setting the served preview polls on, because
   * it is the same question. */
  pollMs: number
  /** `preview.theme` — where the page starts before the reader has pressed the
   * switch. */
  theme: "auto" | "light" | "dark"
  /** `notesDir`, for the sidebar's heading: a studio open on `sample` should say
   * so rather than looking like it is open on nothing. */
  root: string
}

/** The element the boot data is in. Read once, at startup. */
export const BOOT_ID = "anote-studio-boot"

/** `?note=` — which note the studio opens on. The page keeps it in step with the
 * sidebar through `history.replaceState`, so a reload comes back to the note
 * being read and a copied URL opens it. */
export const NOTE_PARAM = "note"

/** `?path=` and `?file=` — the note a route is about, and the file beside it. */
export const PATH_PARAM = "path"
export const FILE_PARAM = "file"
