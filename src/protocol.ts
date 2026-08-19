/**
 * The contract between the extension host and the webview — the one thing both
 * sides read, and the only thing that crosses between them.
 *
 * This is the same rule the Electron app it comes from lives by (`CLAUDE.md`:
 * the main process and the renderer never import each other, everything crossing
 * goes through one file). A webview is that boundary again with a different
 * transport: `ipcRenderer.invoke` becomes `postMessage`, and the discipline is
 * what makes swapping one for the other a change to a bridge rather than to
 * every call site.
 *
 * Types only, no runtime code — nothing here should ever be bundled into one
 * side and not the other.
 */

/** One block of a note's document — BlockNote's own model, as it is on disk.
 *
 * Structural rather than BlockNote's `Block`, because everything that walks a
 * document does so without caring what is in it, and `Block` drags the schema's
 * three type parameters through every signature it touches. Copied from the
 * app's `shared/api.ts`, where it lives for the same reason. */
export type NoteBlock = {
  id?: string
  type?: string
  props?: Record<string, unknown>
  content?: unknown
  children?: NoteBlock[]
}

/**
 * Which file the blocks came out of, and the one thing the webview changes its
 * mind about because of it.
 *
 * A `.note` holds the blocks themselves, so what crosses this boundary is the
 * document. A `.md` holds markdown, and the host converts in both directions
 * (`host/note-markdown.ts`) so that what crosses is *still* the blocks — the
 * webview never sees markdown and never learns to write it.
 *
 * What the webview does with this is take features away: markdown has no
 * colours, no alignment, no underline, no tabs and no toggle lists, and an
 * editor that offers them over a `.md` is an editor that quietly deletes them on
 * the next save. See `webview/editor.tsx`.
 */
export type NoteFormat = "note" | "markdown"

/** What the host tells the webview. */
export type ToWebview =
  /** Sent once the webview says it is ready. The editor is built from this and
   * nothing else, so everything it needs to draw a note is here. */
  | {
      type: "init"
      /** The document's text — a JSON array of blocks, or "" for a new note. */
      text: string
      /**
       * The note's own directory, as a URI the webview may load from.
       *
       * **The legacy base.** Notes written before the shared pool existed hold
       * paths relative to the note itself — `Spec.note.assets/<file>` — and this
       * is what those resolve against. Still sent, and still first in the
       * webview's fork, because a note's pictures going blank on an upgrade is
       * not a trade this extension gets to make.
       */
      dirUri: string
      /**
       * The shared assets directory, as a URI the webview may load from.
       *
       * Where a dropped file goes now: one directory at the notes root, shared by
       * every note in the folder, so a note may be renamed and moved without its
       * pictures being left behind under a name derived from its old filename.
       * See the header of `host/assets.ts`.
       *
       * The webview cannot turn a file path into something it may fetch, so the
       * host resolves both directories once and the webview joins names onto
       * whichever the path names.
       */
      assetsUri: string
      /**
       * What that directory is called — `assets.dir`, and the prefix a stored
       * path carries.
       *
       * Sent rather than assumed, because it is a workspace setting: the webview
       * has to know which of the two URIs above a path belongs to, and the answer
       * is whether it starts with this.
       */
      assetsDir: string
      theme: "dark" | "light"
      /** The file this note is kept in. Sent once, because a document does not
       * change extension while it is open. */
      format: NoteFormat
    }
  /**
   * The document changed underneath the editor — a git checkout, an undo run
   * from outside the webview, another editor on the same file.
   *
   * Distinct from `init` only in what the webview does about it: the editor is
   * rebuilt, losing the caret, which is why this is never sent for an edit the
   * webview itself made. See `note-editor.ts`.
   */
  | { type: "external"; text: string }
  | { type: "theme"; theme: "dark" | "light" }
  /** The answer to `uploadFile`, by the id the webview asked with. */
  | { type: "uploaded"; id: number; path: string }
  | { type: "uploadFailed"; id: number; message: string }
  /** The answers to `writeAsset` and `readAsset`. `base64` is null for a file
   * that is not there — a drawing nobody has drawn in yet, in practice. */
  | { type: "assetWritten"; id: number; failed?: string }
  | { type: "assetRead"; id: number; base64: string | null }

/** What the webview tells the host. */
export type ToHost =
  | { type: "ready" }
  /**
   * The document, as the editor now has it.
   *
   * The whole text rather than a patch: BlockNote's document is JSON and its
   * `onChange` hands over the whole thing, so a diff here would be invented
   * rather than observed. The host turns it into one `WorkspaceEdit`, which is
   * what makes the tab dirty and `⌘S` write it.
   */
  | { type: "edit"; text: string }
  /**
   * A file dropped, pasted or picked into the note.
   *
   * Base64 rather than bytes: a webview message is JSON, and a `Uint8Array` that
   * crosses it arrives as an object with numeric keys. The cost is a third of
   * the size on the way over, paid once per picture.
   */
  | {
      type: "uploadFile"
      id: number
      /** Both, because the type is what the bytes are and the name is the
       * fallback for a type this app has no extension for. */
      name: string
      mime: string
      base64: string
    }
  /**
   * A file beside the note, by a name the webview chose — a drawing's scene, and
   * the picture of it exported for the previews.
   *
   * Separate from `uploadFile`, where the host names the file: a drawing is
   * written repeatedly under a name the document already holds, so the webview has
   * to be the one that says which file. The host refuses a name that is not one of
   * ours and resolves it itself — to wherever that file already is, and to the
   * shared pool for one nothing has written yet (`locateAsset` in
   * `host/assets.ts`).
   */
  | { type: "writeAsset"; id: number; name: string; base64: string }
  | { type: "readAsset"; id: number; name: string }
  /** Something the webview could not recover from, for the host to surface —
   * a webview has no way to show a notification of its own. */
  | { type: "failed"; message: string }
