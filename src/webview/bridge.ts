import type { ToHost, ToWebview } from "../protocol"

/**
 * The editor's end of the one channel it has.
 *
 * This file is the whole of what the editor knows about the host it is running in
 * — everything else in `src/webview/` is React and BlockNote. That mattered from
 * the start as a discipline; it now matters because it is load-bearing: the studio
 * (`src/studio/`) mounts the same editor in an ordinary browser tab, over a
 * loopback socket instead of `postMessage`, and the diff for that is a `Channel`
 * installed here and not one line inside `editor.tsx`.
 *
 * So the transport is injected rather than acquired. Everything below is the same
 * shape as the app's `src/preload/index.ts`: a thunk per call, and the thing above
 * it never touches the wire.
 */

/**
 * A way to send the host a message and to hear the ones it sends back.
 *
 * Two functions, because that is all either host turns out to need — the
 * VS Code one below, and `src/studio/channel.ts`, which answers the same messages
 * out of HTTP requests. The messages themselves stay `src/protocol.ts`'s, which is
 * what makes the second host cost a file rather than a fork.
 */
export type Channel = {
  post: (message: ToHost) => void
  listen: (handle: (message: ToWebview) => void) => () => void
}

let channel: Channel | null = null

/**
 * Installs the channel. Called once, at the top of whichever `main.tsx` is being
 * built, before React mounts anything — a `send` with no channel installed is a
 * message nobody hears, so it throws rather than dropping it.
 */
export function useChannel(next: Channel): void {
  channel = next
}

function host(): Channel {
  if (!channel) {
    throw new Error("No channel installed — see useChannel in bridge.ts")
  }
  return channel
}

type VsCodeApi = {
  postMessage: (message: ToHost) => void
  getState: () => unknown
  setState: (state: unknown) => void
}

declare function acquireVsCodeApi(): VsCodeApi

/**
 * The webview's channel: VS Code's own `postMessage`, both ways.
 *
 * A function rather than the module-scope call this used to be, and that is the
 * one change the studio forced. `acquireVsCodeApi` throws if it is called twice
 * and does not exist at all outside a webview — so as a module-scope call it was
 * a page that failed on load in any other browser, which is exactly where the
 * studio runs the same bundle's editor.
 */
export function vsCodeChannel(): Channel {
  const vscode = acquireVsCodeApi()
  return {
    post: (message) => vscode.postMessage(message),
    listen: (handle) => {
      const listener = (event: MessageEvent<ToWebview>) => handle(event.data)
      window.addEventListener("message", listener)
      return () => window.removeEventListener("message", listener)
    },
  }
}

export function send(message: ToHost): void {
  host().post(message)
}

export function onMessage(handle: (message: ToWebview) => void): () => void {
  return host().listen(handle)
}

/**
 * Writes a file into the workspace beside the note and resolves to the path the
 * document should hold.
 *
 * A message is one way, so a call that expects an answer needs an id and a place
 * to keep the promise until the answer arrives. This is that place — the only one
 * in the extension, since it is the only call the webview makes that has a
 * result.
 */
const uploads = new Map<
  number,
  { resolve: (path: string) => void; reject: (error: Error) => void }
>()
let nextUpload = 1

export function upload(file: File, base64: string): Promise<string> {
  const id = nextUpload++
  return new Promise<string>((resolve, reject) => {
    uploads.set(id, { resolve, reject })
    send({
      type: "uploadFile",
      id,
      name: file.name,
      mime: file.type,
      base64,
    })
  })
}

/**
 * A file beside the note, under a name this side chose — a drawing's scene, and
 * the picture exported from it.
 *
 * The same id-and-a-promise plumbing as `upload`, because a message is one way.
 * Kept as two functions rather than one generic `call()` because there are only
 * three calls with answers in this extension and a dispatcher for three cases
 * hides more than it saves.
 */
const assets = new Map<
  number,
  { resolve: (value: never) => void; reject: (error: Error) => void }
>()
let nextAsset = 1

export function writeAsset(name: string, base64: string): Promise<void> {
  const id = nextAsset++
  return new Promise<void>((resolve, reject) => {
    assets.set(id, {
      resolve: resolve as (value: never) => void,
      reject,
    })
    send({ type: "writeAsset", id, name, base64 })
  })
}

/** The file's bytes as base64, or null for one that is not there. */
export function readAsset(name: string): Promise<string | null> {
  const id = nextAsset++
  return new Promise<string | null>((resolve, reject) => {
    assets.set(id, {
      resolve: resolve as (value: never) => void,
      reject,
    })
    send({ type: "readAsset", id, name })
  })
}

/** Called by the message loop for every answer the calls above wait on. */
export function settleUpload(message: ToWebview): boolean {
  if (message.type === "uploaded") {
    uploads.get(message.id)?.resolve(message.path)
    uploads.delete(message.id)
    return true
  }
  if (message.type === "uploadFailed") {
    uploads.get(message.id)?.reject(new Error(message.message))
    uploads.delete(message.id)
    return true
  }
  if (message.type === "assetWritten") {
    const waiting = assets.get(message.id)
    assets.delete(message.id)
    if (message.failed) waiting?.reject(new Error(message.failed))
    else waiting?.resolve(undefined as never)
    return true
  }
  if (message.type === "assetRead") {
    assets.get(message.id)?.resolve(message.base64 as never)
    assets.delete(message.id)
    return true
  }
  return false
}

/**
 * The bytes of a file as base64.
 *
 * A webview message is JSON: a `Uint8Array` posted across it arrives as an object
 * with numeric keys, which is both wrong and larger than the encoding. `FileReader`
 * rather than a loop over the bytes, because a loop over a 20MB picture blocks the
 * frame the drop happened in.
 */
export function base64Of(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result)
      // `data:<type>;base64,<payload>` — the host wants the payload.
      resolve(result.slice(result.indexOf(",") + 1))
    }
    reader.onerror = () =>
      reject(reader.error ?? new Error("Could not read it"))
    reader.readAsDataURL(file)
  })
}
