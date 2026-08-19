import { createHash } from "node:crypto"
import type { IncomingMessage, ServerResponse } from "node:http"

import { contentTypeOf } from "./note-files"

/**
 * What everything on the loopback port has to get right.
 *
 * One port answers for two of them — `preview-pages.ts`, which hands a note out as a
 * finished page, and `studio-routes.ts`, which hands the whole notes folder to an
 * editor running in the browser — and the half they share is not the interesting
 * half of either. It is the part that must not drift: which interface they bind,
 * which requests they refuse before reading a byte, and how a file with a
 * `Range` header on it is answered.
 *
 * Security code duplicated in two files is security code that is correct in one of
 * them a year later. `note-files.ts` says the same thing about its two tables, and
 * this is the same argument applied to the checks rather than the mappings.
 *
 * It imports no `vscode`, like everything the port is built from, so
 * `test/preview-pages.ts` and `test/studio-routes.ts` can bind real sockets and
 * fetch real pages with no editor in sight.
 */

/**
 * Loopback, and not configurable.
 *
 * `anote.config.json` may pick the *port* (`preview.port`) — a stable URL is the one
 * thing an OS-picked one cannot give you — but not the interface. A server bound to
 * `0.0.0.0` is somebody's own writing offered to the network, and no setting is
 * worth being the thing that did that by accident. The studio makes that worse
 * again, because it writes: a note editor on the network is somebody else's write
 * access to this workspace.
 */
export const LOOPBACK = "127.0.0.1"

/**
 * That the request arrived addressed to this loopback port, by name.
 *
 * The defence against DNS rebinding, and the whole of it. A page at `evil.test`
 * can point that name at 127.0.0.1, at which point the browser believes the
 * loopback server *is* `evil.test` and hands the page the answers — the one way a
 * web page gets to read a note out of here. It cannot, however, change the `Host`
 * header: it says `evil.test`, and a request either server will answer has to say
 * `127.0.0.1` or the port it was forwarded on.
 *
 * `localhost` is allowed alongside the literal address because a reader who
 * retypes the URL will type that, and it resolves to the same interface. A name
 * that is neither is a name these servers were not asked for.
 */
export function sameHost(request: IncomingMessage): boolean {
  const host = request.headers.host
  if (!host) return false
  // `host` carries the port, and an IPv6 literal carries brackets. Only the name
  // is in question here — the port is whichever one the socket is bound to.
  const name = host
    .replace(/:\d+$/, "")
    .replace(/^\[|\]$/g, "")
    .toLowerCase()
  return name === LOOPBACK || name === "localhost" || name === "::1"
}

/**
 * Whether the browser says this request came from another site.
 *
 * `Sec-Fetch-Site` is the browser's own answer and cannot be set by a page, so
 * `cross-site` here is a fetch some other origin started — nothing a reader opening
 * their own note produces. `Origin` is the older half of the same question, sent
 * on exactly the requests that are not plain navigations.
 *
 * Neither is present on a request from something that is not a browser, and for a
 * page that is correct rather than a hole: a program on this machine can read
 * the note off disk, so refusing it here would protect nothing. The studio, which
 * writes, does not stop at this check — see `STUDIO_TOKEN_HEADER`.
 */
export function crossSite(request: IncomingMessage): boolean {
  const site = request.headers["sec-fetch-site"]
  if (typeof site === "string" && site !== "same-origin" && site !== "none") {
    return true
  }
  const origin = request.headers.origin
  if (typeof origin !== "string" || origin === "null") return false
  try {
    const { hostname } = new URL(origin)
    return hostname !== LOOPBACK && hostname !== "localhost"
  } catch {
    return true
  }
}

/**
 * A path as these servers key one: no leading or trailing slash, no empty
 * segment, and nothing that climbs.
 *
 * Both sides go through it — the code that builds a URL and the code that reads
 * one off a request — so the two cannot disagree about what `auth/login.note` is
 * called. A path with a `..` in it comes back empty, which is a path nothing is
 * ever stored under.
 */
export function normalPath(path: string): string {
  const parts = path.split("/").filter((part) => part && part !== ".")
  if (parts.some((part) => part === "..")) return ""
  return parts.join("/")
}

/**
 * The path a request asked for, decoded — `""` for the root, and `null` for one
 * that is not a path at all.
 *
 * The two are told apart deliberately. A URL that climbs, or whose escaping is
 * malformed, is a request nothing should answer; the root is a request one of these
 * servers answers with its own page. Collapsing them into an empty string was how a
 * `..` in the URL quietly got the studio's front page instead of a refusal.
 */
export function pathOf(url: URL): string | null {
  let parts: string[]
  try {
    parts = url.pathname
      .split("/")
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment))
  } catch {
    // `%zz` — not escaping, so not a path.
    return null
  }
  if (parts.some((part) => part === "..")) return null
  return normalPath(parts.join("/"))
}

/** What a note's text hashes to — the ETag both servers answer with, and the
 * version the studio's saves are checked against. Short because it is read by
 * people in a header, and not a signature: nothing trusts it, two things compare
 * it. */
export function versionOf(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 16)
}

/** A text or HTML answer. `version` becomes the ETag, which is what the studio's
 * poll and the preview's reload compare without pulling the body down. */
export function send(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  body: string,
  version?: string,
  type = status === 200 ? "text/html; charset=utf-8" : "text/plain; charset=utf-8"
): void {
  const payload = Buffer.from(body, "utf8")
  response.writeHead(status, {
    "content-type": type,
    "content-length": payload.byteLength,
    // A note is what it is right now; a cached one is what it was, which is the
    // one thing neither server may show.
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...(version ? { etag: `"${version}"` } : {}),
  })
  if (request.method === "HEAD") return void response.end()
  response.end(payload)
}

/** The studio's answers, which are JSON rather than pages. */
export function sendJson(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  value: unknown,
  version?: string
): void {
  send(
    request,
    response,
    status,
    JSON.stringify(value),
    version,
    "application/json; charset=utf-8"
  )
}

/**
 * One of a note's own files, on a request of its own.
 *
 * Range requests are answered because that is what a media element does: a
 * `<video>` asks for the head of the file to find its duration and then for the
 * bytes around wherever the reader drags to. A server that answers every one of
 * those with the whole file gives a player that cannot be seeked — and, for a
 * large clip, one that will not start.
 *
 * Sliced out of the bytes in hand rather than streamed off disk. That is honest
 * only because a note's files are what somebody dropped into a note; a note that
 * could hold an hour of video would want a read stream here.
 *
 * The type comes off the name through the shared table and from nowhere else —
 * never sniffed, never from the request. An extension the table has no entry for
 * is served as bytes, which with `nosniff` is a download rather than a document.
 * That is what keeps this route from serving anything scriptable on a server's own
 * origin: the one entry in the table a browser would run script from is
 * `image/svg+xml`, and callers that render pages inline their SVGs rather than
 * linking them.
 */
export function sendFile(
  request: IncomingMessage,
  response: ServerResponse,
  name: string,
  bytes: Uint8Array,
  type = contentTypeOf(name) ?? "application/octet-stream"
): void {
  const range = rangeOf(request.headers.range, bytes.byteLength)

  if (range === "unsatisfiable") {
    response.writeHead(416, {
      "content-range": `bytes */${bytes.byteLength}`,
      "accept-ranges": "bytes",
    })
    return void response.end()
  }

  const part = range
    ? bytes.subarray(range.start, range.end + 1)
    : bytes
  response.writeHead(range ? 206 : 200, {
    "content-type": type,
    "accept-ranges": "bytes",
    "cache-control": "no-store",
    // Shown where the browser can show it — a PDF in its own viewer beats a file
    // in the downloads tray — which is safe for the reason the type above gives.
    "content-disposition": "inline",
    "x-content-type-options": "nosniff",
    "content-length": part.byteLength,
    ...(range
      ? {
          "content-range": `bytes ${range.start}-${range.end}/${bytes.byteLength}`,
        }
      : {}),
  })
  if (request.method === "HEAD") return void response.end()
  response.end(part)
}

/**
 * The single range a request asked for, or null for one that asked for none.
 *
 * Only `bytes=` and only one range: multipart ranges exist and no media element
 * sends them, so the whole file is a truthful answer to a header this does not
 * understand — where inventing a `multipart/byteranges` body would not be.
 */
export function rangeOf(
  header: string | undefined,
  size: number
): { start: number; end: number } | "unsatisfiable" | null {
  if (!header) return null

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return null

  const [, from, to] = match
  if (!from && !to) return null

  // A suffix range — `bytes=-500`, the last 500 bytes.
  const start = from ? Number(from) : Math.max(0, size - Number(to))
  const end = from ? (to ? Math.min(Number(to), size - 1) : size - 1) : size - 1

  if (start > end || start >= size) return "unsatisfiable"
  return { start, end }
}

/** Whether a URL is a path to a file beside a note — not a scheme of its own, not
 * absolute, and not climbing out of the note's own directory. */
export function isBeside(url: string): boolean {
  if (!url || url.startsWith("/")) return false
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return false
  return !url.split("/").includes("..")
}
