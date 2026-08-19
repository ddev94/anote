import type { Channel } from "../webview/bridge"
import type { ToWebview } from "../protocol"
import { readAsset, uploadFile, writeAsset } from "./api"

/**
 * The editor's channel, answered out of HTTP requests.
 *
 * This is the whole of what it took to run the note editor outside VS Code. The
 * editor sends the same messages it always did (`src/protocol.ts`) and gets the
 * same answers back; what changes is that a `postMessage` to an extension host
 * becomes a `fetch` at a loopback port, and the thing that answers is
 * `host/studio-routes.ts` rather than `host/note-editor.ts`.
 *
 * **Three of the messages, and deliberately not all of them.** `uploadFile`,
 * `writeAsset` and `readAsset` are the ones sent from *inside* the editor — by the
 * image panel, and by a drawing saving its scene — where there is no component in
 * the way that could have been handed a callback instead. Those must come through
 * here or BlockNote's own upload button does nothing.
 *
 * `ready`, `init`, `external` and `edit` are the webview's *page* talking to its
 * host about which note is open and when it changed, and the studio has a better
 * answer for all four: it opens notes from a sidebar, and it saves against a
 * version so that two editors on one file cannot silently overwrite each other
 * (`saveNote` in `api.ts`). So they are not plumbed, and a stray one is a bug worth
 * seeing in the console rather than a message quietly dropped.
 */
export function studioChannel(options: {
  /** The note the editor is currently on. A thunk, because the channel is
   * installed once and the reader moves between notes all day. */
  note: () => string | null
  /** What the editor could not recover from. In the webview this becomes a VS Code
   * notification; here it is the page's own banner, since there is nothing else to
   * show it in. */
  onFailed: (message: string) => void
}): Channel {
  const listeners = new Set<(message: ToWebview) => void>()
  const emit = (message: ToWebview) => {
    for (const listener of listeners) listener(message)
  }

  return {
    listen: (handle) => {
      listeners.add(handle)
      return () => listeners.delete(handle)
    },

    post: (message) => {
      const note = options.note()

      switch (message.type) {
        case "failed":
          return options.onFailed(message.message)

        case "uploadFile": {
          if (!note) {
            return emit({
              type: "uploadFailed",
              id: message.id,
              message: "No note is open to file that beside.",
            })
          }
          void uploadFile(note, {
            name: message.name,
            mime: message.mime,
            base64: message.base64,
          }).then(
            (path) => emit({ type: "uploaded", id: message.id, path }),
            (error: unknown) =>
              emit({
                type: "uploadFailed",
                id: message.id,
                message: reason(error, "Could not save that file."),
              })
          )
          return
        }

        case "writeAsset": {
          if (!note) {
            return emit({
              type: "assetWritten",
              id: message.id,
              failed: "No note is open to write that beside.",
            })
          }
          void writeAsset(note, message.name, message.base64).then(
            () => emit({ type: "assetWritten", id: message.id }),
            (error: unknown) =>
              emit({
                type: "assetWritten",
                id: message.id,
                failed: reason(error, "Could not write it."),
              })
          )
          return
        }

        case "readAsset": {
          /* Null rather than a failure for a note that is not open, because that is
             what "the file is not there" already means to the caller — a drawing
             nobody has drawn in yet opens as an empty canvas. */
          if (!note) {
            return emit({ type: "assetRead", id: message.id, base64: null })
          }
          void readAsset(note, message.name).then(
            (base64) => emit({ type: "assetRead", id: message.id, base64 }),
            () => emit({ type: "assetRead", id: message.id, base64: null })
          )
          return
        }

        default:
          console.warn(
            "The studio does not carry this message — see channel.ts",
            message
          )
      }
    },
  }
}

function reason(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}
