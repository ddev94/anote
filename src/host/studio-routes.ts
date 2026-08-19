import { randomBytes } from "node:crypto"
import type { IncomingMessage, ServerResponse } from "node:http"

import { normalPath, send, sendFile, sendJson, versionOf } from "./http"
import { isAssetName } from "./note-files"
import type { NoteSource } from "./preview-pages"
import { DEFAULT_CONFIG, type PreviewTheme } from "../config"
import {
  API,
  BOOT_ID,
  BUNDLE,
  FILE_PARAM,
  FILES,
  PATH_PARAM,
  VERSION_HEADER,
  type AssetRequest,
  type AssetResult,
  type CreateRequest,
  type NoteResult,
  type NotesResult,
  type Problem,
  type SavedResult,
  type StudioBoot,
  type UploadRequest,
  type UploadedResult,
} from "../studio-api"

/**
 * The studio — the whole notes folder, editable in the browser.
 *
 * The third surface this extension puts a note on, and the one that is neither of
 * the other two: the custom editor is a webview VS Code owns, the served preview is
 * a finished page nobody can type into, and this is the *editor* — the same
 * BlockNote build, the same slash menu, the same drawings — on a loopback URL, with
 * a list of the workspace's notes down the left.
 *
 * **The routes, not the port.** `note-server.ts` owns the socket and answers for
 * both surfaces; this class is what it hands `/`, `/api/…`, `/files/…` and `/~/…`
 * to. It is also the thing that is *not mounted at all* when a workspace sets
 * `studio.enabled` to false, which is a stronger answer than a command that
 * refuses: with nothing mounted, the writable routes do not exist to be asked.
 *
 * **What it is not.** It does not rename, move or delete a note. In VS Code that is
 * the Explorer's job and this extension has never had an opinion about it (see the
 * header of `extension.ts`); in the browser it is simply missing, and missing is
 * the honest state to leave it in rather than growing a second, weaker file manager
 * that a `git status` then has to explain.
 *
 * It imports no `vscode`. What it needs of the workspace arrives as the functions in
 * `StudioWorkspace`, the way the pages take a `NoteSource` — so notes on a remote,
 * in a container or in a virtual filesystem work for free, and
 * `test/studio-routes.ts` drives it over a real socket with a workspace that is a
 * `Map`.
 */

/**
 * What the server is given of the workspace it is serving.
 *
 * Every path crossing this boundary is relative to the notes root, POSIX, and has
 * already been through `notePathOf` below — so an implementation joins rather than
 * validates. The one thing it must still do is refuse to leave the root, because a
 * `..` that got past normalisation would otherwise be its problem.
 */
export type StudioWorkspace = {
  /** Every note under the root, as paths — `auth/Spec.note`. Sorted by the
   * caller; the sidebar's order is this server's answer, not the filesystem's. */
  notes: () => Promise<string[]>
  /** A note's text, or null for one that is not there — a link to a note somebody
   * has since deleted, and what the sidebar's poll notices. */
  read: (path: string) => Promise<string | null>
  write: (path: string, text: string) => Promise<void>
  /** An empty note, and false if there is already a file at that path: the studio
   * creates notes and must never be the thing that wrote over one. */
  create: (path: string) => Promise<boolean>
  /** A file inside some note's own assets directory, by its path under the notes
   * root, or null for one that is not there. */
  file: (path: string) => Promise<Uint8Array | null>
  /** Whether that file is there, asked without reading it. A note's page puts a
   * player around a clip it can see and never pulls the bytes in to find out — see
   * `NoteSource.has` in `preview-pages.ts`, which this is here to answer. */
  exists: (path: string) => Promise<boolean>
  /** A file beside a note under a name the *editor* chose — a drawing's scene and
   * the picture exported from it. Checked against `isAssetName` before it gets
   * here. */
  readAsset: (note: string, name: string) => Promise<Uint8Array | null>
  writeAsset: (note: string, name: string, bytes: Uint8Array) => Promise<void>
  /** A dropped or pasted file, filed beside the note under a name the *host*
   * chooses. Resolves to the path relative to the note that the document will
   * hold — the same answer the webview's `uploadFile` gets. */
  upload: (
    note: string,
    name: string,
    mime: string,
    bytes: Uint8Array
  ) => Promise<string>
  /** One file of this extension's own `dist/` — the studio bundle, and the fonts
   * Excalidraw fetches at runtime. Null for anything that is not there. */
  bundle: (name: string) => Promise<Uint8Array | null>
}

/** What the studio takes out of `anote.config.json`. No port: there is one server
 * and `preview.port` names it — see the header of `note-server.ts`. */
export type StudioSettings = {
  pollMs: number
  theme: PreviewTheme
  /** `notesDir`, shown as the sidebar's heading. */
  root: string
  /** `assets.dirSuffix` — what a note's own directory is called. The one route
   * that has to recognise that directory by name is `/files/`. */
  assets: string
}

/**
 * How much of a request body this server will read.
 *
 * A cap rather than a stream, and it is the same honesty `sendFile` owns up to: a
 * note's files are what somebody dropped into a note, so they are held in memory
 * either way. 64MB is comfortably past any screenshot or diagram and nowhere near
 * enough to be a way of exhausting the editor host by POSTing at a loopback port.
 * Base64 is a third larger than the bytes, so the real ceiling on a file is about
 * 48MB.
 */
const BODY_LIMIT = 64 * 1024 * 1024

/** What the studio's own bundle is served as, by extension. Its own table rather
 * than `note-files.ts`'s, because that one is about what a *note* holds and must
 * never learn to serve `.js`: a note's assets and this extension's code are two
 * different trust levels reaching the same browser. */
const BUNDLE_TYPES: Record<string, string> = {
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  map: "application/json; charset=utf-8",
  woff2: "font/woff2",
  woff: "font/woff",
  ttf: "font/ttf",
}

export class StudioRoutes {
  constructor(
    private readonly workspace: StudioWorkspace,
    /** Read per request, not held: `anote.config.json` is watched and this server
     * outlives a write to it. `port` is the exception, read once when the socket
     * binds — a port already bound is not one a config file can move. */
    private readonly settings: () => StudioSettings = () => ({
      pollMs: DEFAULT_CONFIG.preview.pollMs,
      theme: DEFAULT_CONFIG.preview.theme,
      root: DEFAULT_CONFIG.notesDir,
      assets: DEFAULT_CONFIG.assets.dirSuffix,
    })
  ) {}

  /**
   * Everything under `/api/`, which the caller has already checked the token on.
   *
   * One entry point rather than four public methods, so the port has one thing to
   * call and the routes stay this file's business. `route` is the pathname as
   * `src/studio-api.ts` spells it.
   */
  async api(
    request: IncomingMessage,
    response: ServerResponse,
    asked: URL,
    route: string
  ): Promise<void> {
    if (route === API.notes) return await this.serveNotes(request, response)
    if (route === API.note) return await this.serveNote(request, response, asked)
    if (route === API.asset) return await this.serveAsset(request, response, asked)
    if (route === API.upload) {
      return await this.serveUpload(request, response, asked)
    }
    return sendJson(request, response, 404, {
      problem: `No such route: ${route}`,
    } satisfies Problem)
  }

  /**
   * The note as one of the *pages* reads it — `NoteSource`, out of the folder this
   * studio is on.
   *
   * The bridge between the two surfaces sharing the port, and the reason
   * `/read/auth/login.note` works for a note nobody asked for a link to: the studio
   * already holds the folder, so a page of any note in it is a mapping rather than a
   * lookup. `note-server.ts` calls this when its registry does not have the path,
   * and the trade that makes — a note in the folder being readable at a guessable
   * URL — is written up there.
   *
   * A method rather than a function over `StudioWorkspace`, so the workspace stays
   * private and the one place that knows how a note's own files are named goes on
   * being the only one.
   */
  sourceFor(given: string): NoteSource | null {
    const note = notePathOf(given)
    if (!note) return null

    const dir = note.split("/").slice(0, -1)
    const beside = (relative: string) => [...dir, relative].join("/")
    const assets = `${note.split("/").at(-1) ?? note}${this.settings().assets}`

    return {
      name: nameOf(note),
      studioPath: note,
      /* "" rather than a throw for a note that has gone: the caller has already
         asked whether it is there, and a page is a read — it reports rather than
         refuses. */
      text: async () => (await this.workspace.read(note)) ?? "",
      file: (relative) => this.workspace.file(beside(relative)),
      has: (relative) => this.workspace.exists(beside(relative)),
      drawingSvg: async (id) => {
        const name = `${id}.svg`
        // The name is built from an id the document holds, so it is checked the
        // same way every other name the document chose is.
        if (!isAssetName(name)) return ""
        const bytes = await this.workspace.readAsset(note, name)
        return bytes ? Buffer.from(bytes).toString("utf8") : ""
      },
    }
  }

  /** Whether there is a note at this path at all — asked by the port before it
   * builds a page out of `sourceFor`, so a path nobody has written is a 404 and not
   * an empty document. */
  async holds(given: string): Promise<boolean> {
    const note = notePathOf(given)
    return note ? (await this.workspace.read(note)) !== null : false
  }

  /** `GET /api/notes`, and `POST` to make one. */
  private async serveNotes(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    if (request.method === "GET" || request.method === "HEAD") {
      const notes = (await this.workspace.notes())
        .map((path) => normalPath(path))
        .filter((path) => path.endsWith(".note"))
        .sort()
      return sendJson(request, response, 200, {
        notes: notes.map((path) => ({ path, name: nameOf(path) })),
      } satisfies NotesResult)
    }

    if (request.method !== "POST") {
      return sendJson(request, response, 405, {
        problem: "Only GET and POST here.",
      } satisfies Problem)
    }

    const body = await this.body<CreateRequest>(request)
    const path = notePathOf(body?.path)
    if (!path) {
      return sendJson(request, response, 400, {
        problem: "A note's path under the notes folder, ending in .note.",
      } satisfies Problem)
    }

    /* False rather than an overwrite. The sidebar's `+` is one keystroke from a
       name that already exists, and a studio that answered that by replacing the
       note would be the only thing in this extension that can lose one. */
    if (!(await this.workspace.create(path))) {
      return sendJson(request, response, 409, {
        problem: `There is already a note at ${path}.`,
      } satisfies Problem)
    }
    return sendJson(request, response, 201, {
      path,
      name: nameOf(path),
    })
  }

  /** `GET /api/note` for the note, `HEAD` for just its version, `PUT` to save. */
  private async serveNote(
    request: IncomingMessage,
    response: ServerResponse,
    asked: URL
  ): Promise<void> {
    const path = notePathOf(asked.searchParams.get(PATH_PARAM))
    if (!path) {
      return sendJson(request, response, 400, {
        problem: "A note's path under the notes folder, ending in .note.",
      } satisfies Problem)
    }

    if (request.method === "PUT") return await this.saveNote(request, response, path)

    if (request.method !== "GET" && request.method !== "HEAD") {
      return sendJson(request, response, 405, {
        problem: "Only GET, HEAD and PUT here.",
      } satisfies Problem)
    }

    const text = await this.workspace.read(path)
    if (text === null) {
      return sendJson(request, response, 404, {
        problem: `There is no note at ${path} any more.`,
      } satisfies Problem)
    }

    const version = versionOf(text)
    /* What the page's poll asks for: the version, without pulling the note down
       every few seconds. The same trick the served preview plays with its ETag. */
    if (request.method === "HEAD") {
      return sendJson(request, response, 200, {}, version)
    }

    return sendJson(
      request,
      response,
      200,
      {
        path,
        name: nameOf(path),
        text,
        version,
        /* Where the editor resolves a picture's relative path against — the
           studio's answer to `asWebviewUri`. A note at the root of the folder
           gets `/files`, and the join in `editor.tsx` adds the slash. */
        dirUrl: `/${[FILES, ...path.split("/").slice(0, -1)].join("/")}`,
      } satisfies NoteResult,
      version
    )
  }

  /**
   * A save, checked against the version the page loaded.
   *
   * The check is the difference between this and every other write in the
   * extension, and the reason is that the studio is the one editor that cannot see
   * the others: the same note may be open in a VS Code tab, being rewritten by the
   * MCP server, or checked out from underneath all of them by git. A tab that has
   * been sitting open since this morning holds a document from this morning, and
   * writing it back is how an afternoon's work disappears.
   *
   * So a save says which version it is replacing, and a save against a version the
   * file has moved on from is refused with the version it is actually at — which
   * is enough for the page to offer to load it. A save with no version header at
   * all is refused too: that is a client that has not thought about it.
   */
  private async saveNote(
    request: IncomingMessage,
    response: ServerResponse,
    path: string
  ): Promise<void> {
    const expected = request.headers[VERSION_HEADER]
    if (typeof expected !== "string" || !expected) {
      return sendJson(request, response, 428, {
        problem: `A save must say which version it replaces — ${VERSION_HEADER}.`,
      } satisfies Problem)
    }

    const current = await this.workspace.read(path)
    if (current === null) {
      return sendJson(request, response, 404, {
        problem: `There is no note at ${path} any more.`,
      } satisfies Problem)
    }

    const version = versionOf(current)
    if (version !== expected) {
      return sendJson(request, response, 409, {
        problem: `${nameOf(path)} changed underneath the studio.`,
        version,
      } satisfies Problem)
    }

    const text = await this.text(request)
    /*
     * Parsed to check it is a note, and thrown away.
     *
     * The strict read in the MCP server's `workspace.ts` makes the same point from
     * the other side: a preview may answer an unreadable file with an empty note,
     * but a *write* has to refuse, or the one editor with no undo history behind it
     * becomes the way a note is lost. What lands on disk is the text as it arrived
     * — reserialising it here would mean a save could rewrite a note nobody
     * edited.
     */
    let parsed: unknown
    try {
      parsed = text.trim() ? JSON.parse(text) : []
    } catch {
      return sendJson(request, response, 400, {
        problem: "That is not a note — its JSON does not parse.",
      } satisfies Problem)
    }
    if (!Array.isArray(parsed)) {
      return sendJson(request, response, 400, {
        problem: "That is not a note — a note is an array of blocks.",
      } satisfies Problem)
    }

    await this.workspace.write(path, text)
    return sendJson(request, response, 200, {
      version: versionOf(text),
    } satisfies SavedResult)
  }

  /**
   * `GET` and `PUT /api/asset` — a file beside a note, as base64.
   *
   * The editor's own two file calls, which are about a drawing: the scene it
   * reopens and the picture it exports for the previews to render. Everything the
   * *page* merely displays goes through `/files/` instead, because an `<img>` has
   * no headers to carry the token and no interest in JSON.
   */
  private async serveAsset(
    request: IncomingMessage,
    response: ServerResponse,
    asked: URL
  ): Promise<void> {
    const path = notePathOf(asked.searchParams.get(PATH_PARAM))
    const name = asked.searchParams.get(FILE_PARAM) ?? ""
    if (!path || !isAssetName(name)) {
      return sendJson(request, response, 400, {
        problem: `Not a name beside a note: ${name}`,
      } satisfies Problem)
    }

    if (request.method === "PUT") {
      const body = await this.body<AssetRequest>(request)
      if (typeof body?.base64 !== "string") {
        return sendJson(request, response, 400, {
          problem: "A file to write, as base64.",
        } satisfies Problem)
      }
      await this.workspace.writeAsset(
        path,
        name,
        Buffer.from(body.base64, "base64")
      )
      return sendJson(request, response, 200, {})
    }

    if (request.method !== "GET") {
      return sendJson(request, response, 405, {
        problem: "Only GET and PUT here.",
      } satisfies Problem)
    }

    const bytes = await this.workspace.readAsset(path, name)
    /* Null rather than a 404: "a drawing nobody has drawn in yet" is the ordinary
       case here, and the editor opens an empty canvas on it. Same answer the
       webview's `readAsset` gives. */
    return sendJson(request, response, 200, {
      base64: bytes ? Buffer.from(bytes).toString("base64") : null,
    } satisfies AssetResult)
  }

  /** `POST /api/upload` — a dropped or pasted file, filed beside the note under a
   * name the host chooses. The webview's `uploadFile`, over a socket. */
  private async serveUpload(
    request: IncomingMessage,
    response: ServerResponse,
    asked: URL
  ): Promise<void> {
    if (request.method !== "POST") {
      return sendJson(request, response, 405, {
        problem: "Only POST here.",
      } satisfies Problem)
    }

    const path = notePathOf(asked.searchParams.get(PATH_PARAM))
    const body = await this.body<UploadRequest>(request)
    if (!path || typeof body?.base64 !== "string") {
      return sendJson(request, response, 400, {
        problem: "A note to file it beside, and the file as base64.",
      } satisfies Problem)
    }

    const stored = await this.workspace.upload(
      path,
      typeof body.name === "string" ? body.name : "file",
      typeof body.mime === "string" ? body.mime : "",
      Buffer.from(body.base64, "base64")
    )
    return sendJson(request, response, 201, {
      path: stored,
    } satisfies UploadedResult)
  }

  /**
   * `/files/…` — the pictures, clips and PDFs the note points at.
   *
   * **Only what is inside some note's own assets directory**, and that is the whole
   * of what this route will serve. The notes root defaults to the workspace folder
   * itself, so "any file under the root" would have been this extension serving a
   * repository over a socket — the thing a note's page refuses by never
   * turning a URL into a path at all. Here a path is unavoidable, because the
   * editor resolves relative URLs against a directory, so it is checked instead:
   * the segment holding the file has to be a `<note>.assets` directory.
   */
  async files(
    request: IncomingMessage,
    response: ServerResponse,
    given: string
  ): Promise<void> {
    const suffix = this.settings().assets
    const path = normalPath(given)
    const parts = path.split("/")
    const parent = parts.at(-2)
    if (parts.length < 2 || !parent?.endsWith(suffix) || parent === suffix) {
      return send(request, response, 404, "Not found")
    }

    const bytes = await this.workspace.file(path)
    if (!bytes) return send(request, response, 404, "Not found")
    return sendFile(request, response, path, bytes)
  }

  /** `/~/…` — this extension's own `dist/`: the studio bundle, and the fonts
   * Excalidraw fetches at runtime from `EXCALIDRAW_ASSET_PATH`. */
  async bundle(
    request: IncomingMessage,
    response: ServerResponse,
    given: string
  ): Promise<void> {
    const name = normalPath(given)
    const type = BUNDLE_TYPES[name.slice(name.lastIndexOf(".") + 1).toLowerCase()]
    /* An extension off the list or nothing, so this route cannot become a way to
       read arbitrary files out of the extension's own directory either. */
    if (!name || !type || !/^[A-Za-z0-9._/-]+$/.test(name)) {
      return send(request, response, 404, "Not found")
    }

    const bytes = await this.workspace.bundle(name)
    if (!bytes) return send(request, response, 404, "Not found")
    return sendFile(request, response, name, bytes, type)
  }

  /**
   * The page.
   *
   * Almost nothing: a stylesheet, a bundle, and the four things the app needs
   * before its first fetch (`StudioBoot`). Unlike the served preview — which is
   * finished HTML precisely so that something which does not run scripts can read
   * it — the studio *is* a script, so there is nothing to be gained by rendering
   * the note here as well.
   *
   * The boot data is a `<script type="application/json">`, which a browser does not
   * execute and a cross-origin page cannot read. That is where the token lives, so
   * it is worth saying why it is not simply interpolated into the bundle's own
   * script: a JSON block needs no escaping rules to be safe, and the one thing this
   * page must not do is let a note's path become code.
   */
  page(token: string): string {
    const settings = this.settings()
    /* Per page rather than per server: a nonce is only worth anything while it is
       unguessable to whatever might be trying to inject a script into this
       document, and one minted at startup is one every page of the run shares. */
    const nonce = randomBytes(16).toString("hex")
    const boot: StudioBoot = {
      token,
      /* Read by the page off its own URL rather than baked in here — the page
         rewrites it with `replaceState` as the reader moves between notes, and a
         value in two places is a value that disagrees with itself after one
         click. */
      note: null,
      pollMs: settings.pollMs,
      theme: settings.theme,
      root: settings.root,
    }

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data: blob: https:; media-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self'; script-src 'self' 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ANote Studio</title>
<link rel="stylesheet" href="/${BUNDLE}/studio.css">
</head>
<body>
<div id="root"></div>
<script type="application/json" id="${BOOT_ID}">${json(boot)}</script>
<script nonce="${nonce}">window.EXCALIDRAW_ASSET_PATH = "/${BUNDLE}/excalidraw/";</script>
<script nonce="${nonce}" src="/${BUNDLE}/studio.js"></script>
</body>
</html>`
  }

  /** The request's body as text, up to `BODY_LIMIT`. */
  private text(request: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let size = 0
      request.on("data", (chunk: Buffer) => {
        size += chunk.byteLength
        if (size > BODY_LIMIT) {
          request.destroy()
          reject(new Error("That is larger than the studio will accept."))
          return
        }
        chunks.push(chunk)
      })
      request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
      request.on("error", reject)
    })
  }

  /** The body as JSON, or null for one that is not — the caller says what it
   * needed, which is a better message than "unexpected token". */
  private async body<T>(request: IncomingMessage): Promise<T | null> {
    const text = await this.text(request)
    try {
      return text ? (JSON.parse(text) as T) : null
    } catch {
      return null
    }
  }
}

/**
 * A note's path as this server will accept one, or "" for anything else.
 *
 * The one gate every route's `path` goes through, so `..`, an absolute path and a
 * file that is not a note are all refused in one place rather than in five. Same
 * rule as the MCP server's `pathOf` (`src/mcp/workspace.ts`), and for the same two
 * reasons: outside the folder is a caller reaching for somebody's `.ssh`, and not a
 * `.note` is a caller about to write a block document over a source file.
 */
export function notePathOf(given: string | null | undefined): string {
  if (typeof given !== "string") return ""
  const path = normalPath(given.replace(/\\/g, "/"))
  if (!path || path.startsWith("/") || /^[A-Za-z]:/.test(path)) return ""
  return path.endsWith(".note") ? path : ""
}

/** What the sidebar shows: the filename with `.note` taken off. */
function nameOf(path: string): string {
  return (path.split("/").pop() ?? path).replace(/\.note$/, "")
}

/**
 * JSON, safe to put inside a `<script>` element.
 *
 * `</script>` inside a string would end the element early — and a note's path is in
 * here, so that is a filename somebody could choose. The two line separators are
 * the older half of the same problem: valid JSON, and not valid JavaScript source
 * before ES2019.
 */
function json(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")
}
