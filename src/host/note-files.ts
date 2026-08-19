/**
 * What a file dropped into a note is stored as.
 *
 * Read in both directions, like the app's own `shared/note-files.ts`. Storing a
 * dropped file needs the type the browser gave it turned into an extension; serving
 * one back over the preview's socket needs the extension turned into a type. Two
 * tables would eventually disagree, and a file stored as `.mp4` and served as
 * `video/quicktime` is a player showing nothing.
 *
 * The webview never needs the second direction: it reads a picture through
 * `asWebviewUri`, which is a URL rewrite and cares nothing for the type. The
 * loopback preview does, because it is an HTTP server and a content type is what a
 * browser decides with.
 */
const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "video/mp4": "mp4",
  "video/webm": "webm",
  /* A screen recording on a Mac is a `.mov`, which is what a note holds the first
     time anybody drops one in — and with no entry here it was served as
     `application/octet-stream`, so
     the page and the studio both drew a player that would not play. Nothing about a
     QuickTime container is scriptable, which is the only question this table asks. */
  "video/quicktime": "mov",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "application/pdf": "pdf",
}

const CONTENT_TYPES = new Map(
  Object.entries(EXTENSIONS).map(([type, extension]) => [extension, type])
)

/**
 * What to serve a stored file as, from its own name, or null for an extension this
 * table has no entry for — the caller decides what that means.
 */
export function contentTypeOf(name: string): string | null {
  const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase()
  return CONTENT_TYPES.get(extension) ?? null
}

/**
 * The extension to store a file under, without the dot.
 *
 * The type first, because that is what the bytes actually are and what the file
 * dialog filtered on — a name is a label, and a screenshot pasted out of the
 * clipboard has none. The name is fallen back to for a type this table has no
 * entry for, and `bin` after that: a name a path can safely be built from, and
 * one nothing will try to decode.
 */
export function extensionFor(name: string, mime: string): string {
  const known = EXTENSIONS[mime.toLowerCase()]
  if (known) return known

  const suffix = name.slice(name.lastIndexOf(".") + 1)
  return /^[a-z0-9]{1,8}$/i.test(suffix) && suffix !== name
    ? suffix.toLowerCase()
    : "bin"
}

/**
 * Whether this is a name the editor may write beside a note.
 *
 * The guard on the two calls that let the *editor* pick a filename — a drawing's
 * scene, and the picture exported from it. Those names come from the document,
 * which is a file on disk and could say anything, so what arrives is checked
 * against the shape this app writes rather than sanitised: an id, a dot, and a
 * short extension. No separators, so there is no `..` to reason about.
 *
 * Here rather than beside either caller because there are two of them now and they
 * are in different worlds — `note-editor.ts` answers the webview over
 * `postMessage`, `studio-routes.ts` answers a browser over a socket — and a check
 * that is stricter in one of them is a check that does nothing.
 */
export function isAssetName(name: string): boolean {
  return /^[0-9a-z-]{1,64}\.[a-z0-9]{1,12}$/i.test(name)
}
