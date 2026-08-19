import { randomBytes, timingSafeEqual } from "node:crypto"
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http"

import {
  crossSite,
  LOOPBACK,
  normalPath,
  pathOf,
  sameHost,
  send,
  sendJson,
} from "./http"
import {
  previewNote,
  type NoteSource,
  type PreviewSettings,
} from "./preview-pages"
import {
  notePathOf,
  StudioRoutes,
  type StudioSettings,
  type StudioWorkspace,
} from "./studio-routes"
import { DEFAULT_CONFIG } from "../config"
import { BUNDLE, FILES, NOTE_PARAM, READ, TOKEN_HEADER } from "../studio-api"

/**
 * The notes, on a port.
 *
 * One socket, one link to remember, and two surfaces on it:
 *
 * - `/read/auth/login.note` — the note as a finished page (`preview-pages.ts`).
 *   Nothing has to run for the words to be on it, which is what makes it something
 *   you can hand to `curl`, or to a colleague who only wants to read.
 * - `/` — the studio (`studio-routes.ts`): the folder down the left, the block
 *   editor on the right, and writes.
 *
 * **These used to be two servers on two ports** and merging them was asked for, so
 * it is worth writing down what it bought and what it cost.
 *
 * It bought one link, and the two buttons that only make sense on one origin: the
 * page has **Edit**, the studio has **Open as page**, and both are plain `<a>`
 * hrefs to the same host and port. Two ports could only have offered that by one
 * server knowing the other's URL.
 *
 * It cost the isolation two origins were giving for free, and the place that shows
 * is the page: a note's drawings are inlined as SVG, and an SVG is markup — so a
 * crafted `.svg` in a note's assets directory was already script running on the
 * preview's origin. On its own port that origin held other people's *notes*; on
 * this one it also holds the studio's API, and the token to use it is in the page at
 * `/`. That is why the studio's document carries a nonce-based CSP: an injected
 * inline `<script>` has no nonce, so it does not run, and the token stays where it
 * was put. The hole predates the merge; the merge is what made it worth closing.
 *
 * **A link lives as long as the window.** The paths outlive a relaunch — they are
 * the notes', not something made up — but the port does not, and neither does the
 * registry: nothing is written down, so a tab left open overnight is a dead tab
 * rather than a page still serving somebody's notes.
 *
 * It imports no `vscode`. Both halves take their world as functions — a `NoteSource`
 * per note for the pages, a `StudioWorkspace` for the studio — which is what lets
 * `test/preview-pages.ts` and `test/studio-routes.ts` bind real sockets with no
 * editor anywhere in sight.
 */
export class NoteServer {
  private server: Server | null = null
  private port = 0
  /** One chain, so two links asked for in the same moment cannot each bind a
   * server and leave one of them held by nothing. */
  private starting: Promise<number> | null = null

  /**
   * The token every `/api/` request must carry — see `TOKEN_HEADER` in
   * `src/studio-api.ts` for why the studio needs one where a page does not.
   *
   * Minted per server, so it dies with the window along with the port. It is handed
   * to the studio's document and nowhere else, which means anything that can already
   * `GET /` on this machine can have it — and that is the same bargain the pages
   * make, for the same reason: a local process can read the `.note` files directly.
   * What the token is actually standing in front of is a *browser*, which cannot
   * read files but can be talked into posting at a loopback port.
   */
  private readonly token = randomBytes(24).toString("hex")

  /**
   * The workspace's settings, asked for rather than held.
   *
   * A function, because `anote.config.json` is watched and this server outlives a
   * write to it: the poll interval and the starting palette are read per request, so
   * editing the file changes the next page rather than the next window. `port` is
   * the exception — it is read once, when the socket binds, and a port already bound
   * is not one a config file can move.
   *
   * Optional so that the tests can bind a real server with no workspace anywhere in
   * sight.
   */
  constructor(
    private readonly settings: () => PreviewSettings = () =>
      DEFAULT_CONFIG.preview
  ) {}

  /**
   * The notes this server will answer for as pages, by the path they are addressed
   * at.
   *
   * **A registry, and it is what makes a page of a note *outside* the notes folder
   * possible at all.** A note reaches it by somebody asking for a link to it and no
   * other way. It used to be the whole of what was not served; with a studio on the
   * same port that is no longer true — see `noteAt`, where the second answer is —
   * and the honest description now is that this map is the mechanism for notes the
   * studio cannot name.
   */
  private readonly notes = new Map<string, NoteSource>()

  /** The studio, or null for a window where nothing has opened it and a workspace
   * that has turned it off. Not mounted means the routes do not exist: `/`,
   * `/api/…`, `/files/…` and `/~/…` all answer 404. */
  private studio: StudioRoutes | null = null

  /**
   * Mounts the studio on a folder — or moves it to another one.
   *
   * **One folder at a time**, because the studio is a sidebar of *the* notes folder
   * and a multi-root window has several. Moving it keeps the port and the link: what
   * changes is which folder the sidebar shows, and an open tab will notice at its
   * next poll. That is better than what a server per folder would have meant — a new
   * port, a stale tab, and every preview link on the old one going dead.
   */
  mountStudio(
    workspace: StudioWorkspace,
    settings: () => StudioSettings
  ): void {
    this.studio = new StudioRoutes(workspace, settings)
  }

  /** Whether a studio is mounted — which is what decides whether a page gets an
   * **Edit** link. */
  get hasStudio(): boolean {
    return this.studio !== null
  }

  /**
   * The loopback link to a note as a page, binding the server if this is the first
   * thing asked for.
   *
   * The URL as this machine sees it. Turning it into one the *user's* browser can
   * reach is the caller's job — with VS Code attached to a remote this code is
   * running there, and `127.0.0.1` on that machine is not somewhere the browser on
   * this one can go. `vscode.env.asExternalUri` is what bridges that, and it lives
   * with the other environment questions in `extension.ts`.
   */
  async linkTo(path: string, source: NoteSource): Promise<string> {
    const port = await this.start()

    /*
     * The note's own path, which is a deliberate trade and not a simplification.
     *
     * This used to be a 16-byte secret and a made-up id, and the URL gave away
     * neither the note's name nor where it was. A readable link cannot do that: a
     * path is a path, and anything that can reach the port can ask for
     * `read/auth/login.note` without having been handed anything.
     *
     * What that is worth is less than it sounds, and the reason is who can reach the
     * port. A process on this machine could always read the `.note` off disk — the
     * secret never stood between them. The one caller it did stand in front of is a
     * page in the reader's browser, which cannot read files but can be made to fetch
     * a loopback URL, and the way it gets to read the answer is DNS rebinding —
     * resolving its own hostname to 127.0.0.1 until the browser calls it
     * same-origin. That is stopped by `sameHost` and `crossSite` in `http.ts`, which
     * check what the request arrived carrying and refuse a cross-site one. Those
     * checks do not depend on a secret staying secret, which is the reason they can
     * replace one.
     *
     * The path is the caller's to choose and the caller's to keep unique — see
     * `pathFor` in `extension.ts`. Slashes are kept as slashes: this is one path,
     * spent as several segments.
     */
    const key = normalPath(path)
    // Replaced rather than kept, so a second link to the same note reads it through
    // the caller's newest functions.
    this.notes.set(key, source)

    return `${this.origin(port)}/${READ}/${segments(key)}`
  }

  /**
   * The studio's URL, binding the server if it is not up yet.
   *
   * `note` is the note to open on, and it is only ever a suggestion: the page asks
   * for it like any other and gets the sidebar with nothing open if it has gone.
   */
  async studioLink(note?: string): Promise<string> {
    const port = await this.start()
    const path = note ? notePathOf(note) : ""
    return path
      ? `${this.origin(port)}/?${NOTE_PARAM}=${encodeURIComponent(path)}`
      : `${this.origin(port)}/`
  }

  dispose(): void {
    const server = this.server
    this.server = null
    this.starting = null
    this.studio = null
    this.notes.clear()
    server?.closeAllConnections()
    server?.close()
  }

  private origin(port: number): string {
    return `http://${LOOPBACK}:${port}`
  }

  private start(): Promise<number> {
    if (this.server) return Promise.resolve(this.port)
    this.starting ??= new Promise<number>((resolve, reject) => {
      const server = createServer((request, response) => {
        void this.serve(request, response)
      })

      server.once("error", (error) => {
        this.starting = null
        reject(error)
      })
      /* Port 0 — the default — is the OS picking one that is free, which is the only
         way to bind without asking the user to keep a port setting out of everything
         else's way. A workspace that would rather have a URL it can bookmark says so
         in `preview.port`, and pays for it by owning the clash if something else is
         already there: that is the `error` above, and it comes back as the message
         on the command that asked for a link. */
      server.listen(this.settings().port, LOOPBACK, () => {
        const address = server.address()
        this.server = server
        this.port = typeof address === "object" && address ? address.port : 0
        resolve(this.port)
      })
    })
    return this.starting
  }

  private async serve(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    try {
      /*
       * Where the secret used to be — see `linkTo` for what replaced it and why.
       *
       * Both of these refuse the request outright rather than narrowing it, because
       * neither is a thing a reader's own browser ever does: `Host` is how a page
       * that has pointed its own name at 127.0.0.1 arrives, and a cross-site
       * `Sec-Fetch-Site` is how one that has not tried anyway does. They are the
       * first thing either surface does, before a byte of the request is read.
       */
      if (!sameHost(request) || crossSite(request)) {
        return send(request, response, 404, "Not found")
      }

      const asked = new URL(request.url ?? "/", `http://${LOOPBACK}`)
      const path = pathOf(asked)
      const method = request.method ?? "GET"

      /* Not a path — it climbed, or its escaping was malformed. Refused rather than
         normalised into something that would have been answered. */
      if (path === null) return send(request, response, 404, "Not found")

      const [first, ...rest] = path.split("/")
      const under = rest.join("/")

      // The studio's own document. Nothing else lives at the root.
      if (!path) {
        if (!this.studio) return send(request, response, 404, NO_STUDIO)
        if (method !== "GET" && method !== "HEAD") {
          return send(request, response, 405, "Method not allowed")
        }
        return send(request, response, 200, this.studio.page(this.token))
      }

      if (first === READ) {
        /* Read-only, and it says so: a page that answered a POST would be a second
           way into somebody's files, and the one route that does accept a write is
           behind the token. */
        if (method !== "GET" && method !== "HEAD") {
          return send(request, response, 405, "Method not allowed")
        }
        return await this.servePage(request, response, asked, under)
      }

      if (first === BUNDLE || first === FILES) {
        if (!this.studio) return send(request, response, 404, NO_STUDIO)
        if (method !== "GET" && method !== "HEAD") {
          return send(request, response, 405, "Method not allowed")
        }
        return first === BUNDLE
          ? await this.studio.bundle(request, response, under)
          : await this.studio.files(request, response, under)
      }

      /*
       * Everything left is the JSON API, and the token is the whole of what makes it
       * writable — checked here, once, rather than in each of the routes it leads to,
       * so a route added later cannot forget it.
       */
      if (!this.studio) {
        return sendJson(request, response, 404, { problem: NO_STUDIO })
      }
      if (!this.authorised(request)) {
        return sendJson(request, response, 403, {
          problem: "This request did not carry the studio's token.",
        })
      }
      return await this.studio.api(request, response, asked, `/${path}`)
    } catch (error) {
      console.error("Could not answer that", error)
      /* Plain text, because the two things that reach this are a page and a fetch,
         and only one of them would have known what to do with JSON. The routes that
         *are* the API answer failures in their own shape long before here. */
      send(request, response, 500, "That failed")
    }
  }

  /** `/read/<the note's path>` — the note as a page, or one of the files beside
   * it. */
  private async servePage(
    request: IncomingMessage,
    response: ServerResponse,
    asked: URL,
    path: string
  ): Promise<void> {
    const note = await this.noteAt(normalPath(path))
    if (!note) return send(request, response, 404, "Not found")

    /* The studio's URL for the same note, which becomes the **Edit** link. Only
       when there is a studio to send anybody to, and only for a note it can
       address. */
    const edit =
      this.studio && note.studioPath
        ? `/?${NOTE_PARAM}=${encodeURIComponent(note.studioPath)}`
        : null

    return await previewNote(
      request,
      response,
      note,
      asked,
      this.settings(),
      edit
    )
  }

  /**
   * The note at a path, in the two ways there are one.
   *
   * **The registry first** — a note somebody asked for a link to, which is the only
   * way to reach one that is not under the notes folder at all.
   *
   * **Then the studio's folder**, and this is the part the merge added. A note in the
   * folder is readable at a guessable URL now, where before a page was served only
   * for a note that had been registered. What it buys is the studio's **Open as
   * page** button working as a plain link, and the reason it is an acceptable trade
   * is that the same port already hands that whole folder to the studio: the delta
   * is that a `.note` under the root can be read without the token by something that
   * gets past `sameHost` and `crossSite` — which means a process on this machine,
   * which could read the file off disk anyway. Writes are still token-gated, and a
   * file that is not a `.note` is still not served by anything here.
   */
  private async noteAt(path: string): Promise<NoteSource | null> {
    if (!path) return null

    const registered = this.notes.get(path)
    if (registered) return registered

    const studio = this.studio
    if (!studio || !(await studio.holds(path))) return null
    return studio.sourceFor(path)
  }

  /** Whether the request carried this run's token. Compared in constant time —
   * cheap, and the alternative is a comparison whose timing is a hint. */
  private authorised(request: IncomingMessage): boolean {
    const given = request.headers[TOKEN_HEADER]
    if (typeof given !== "string" || given.length !== this.token.length) {
      return false
    }
    return timingSafeEqual(Buffer.from(given), Buffer.from(this.token))
  }
}

/** What the studio's routes say when nothing is mounted — a workspace that turned
 * it off, or a window with no folder open. Said rather than left as a bare 404,
 * because "off" and "broken" look identical from a browser otherwise. */
const NO_STUDIO =
  "No studio here — this workspace has not opened one, or studio.enabled is false."

/** A path, spent as several encoded segments. */
function segments(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/")
}
