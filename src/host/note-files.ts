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

/**
 * The name a dropped file is stored under: its own, kept.
 *
 * The old rule here was a fresh UUID, on the reasoning that nothing the user's
 * filesystem named should reach a path of ours. That is the right instinct and
 * the wrong conclusion — it also meant a note's directory was a list of
 * `b7f1e0c2-9d34-4a55-8c71-2f0e6ab41d90.png`, which nobody can read, nothing can
 * be found in by name, and a `git diff` cannot say anything useful about. A name
 * is the one piece of metadata a dropped file arrives with and throwing it away
 * costs more than it saves.
 *
 * So the name is *kept*, and made safe rather than replaced:
 *
 * - The extension still comes from `extensionFor` — the browser's type first —
 *   because that is what the bytes actually are. A `.jpg` that is really a PNG
 *   goes in as `.png`, and a name with no extension at all still gets one.
 * - The stem keeps letters, marks, digits, dot, dash and underscore, and every
 *   other character — separators, spaces, `%`, `:`, the shell's punctuation, the
 *   control range — becomes a dash. Letters are Unicode letters, so `báo cáo.pdf`
 *   is stored as `báo-cáo.pdf` rather than mangled into ASCII: this is a
 *   filename, not an identifier.
 * - There is no `/`, no `\` and no `..` left in it, which is the property every
 *   caller relies on and the reason the old rule existed.
 *
 * Two files dropped under one name is not this function's problem: it answers
 * what the name *should* be, and `storeAsset` in `host/assets.ts` is what turns
 * that into a name that is free.
 */
export function assetFilenameFor(name: string, mime: string): string {
  const extension = extensionFor(name, mime)
  /* The basename, on both separators. A `File` from a directory drop carries a
     relative path in `name`, and a browser on Windows may hand over either. */
  const base = (name.split(/[\\/]/).pop() ?? "").normalize("NFC")
  const dot = base.lastIndexOf(".")
  // `> 0`, so a dotfile — `.env` — keeps its name and is not read as all
  // extension and no stem.
  return `${assetStem(dot > 0 ? base.slice(0, dot) : base)}.${extension}`
}

/** How long a stem may be, in characters. Well inside the 255 *bytes* a
 * filesystem allows even where every character costs three of them, and long
 * enough that a name is still recognisable after the cut. */
const STEM_LIMIT = 60

/** Names Windows will not give a file, whatever the extension. Kept because a
 * note is a file in a repository somebody else may clone onto Windows, and a
 * picture that cannot be checked out is a broken note there and nowhere else. */
const RESERVED =
  /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/** The readable half of a stored name, with everything a path or a URL would
 * argue about taken out of it. */
function assetStem(stem: string): string {
  const safe = stem
    // Unicode letters, the marks that compose them, digits, and the three
    // punctuation characters a filename is expected to hold.
    .replace(/[^\p{L}\p{M}\p{N}._-]+/gu, "-")
    .replace(/-{2,}/g, "-")
    .slice(0, STEM_LIMIT)
    /* Leading and trailing dots and dashes, after the cut rather than before it:
       trimming first and slicing second is how a stem ends up back on a dash. A
       leading dot would make the file hidden, a trailing one is a name Windows
       silently drops, and `.`/`..` are the two that are not names at all. */
    .replace(/^[.\-]+/, "")
    .replace(/[.\-]+$/, "")

  return !safe || RESERVED.test(safe) ? `file-${safe}`.replace(/-$/, "") : safe
}
