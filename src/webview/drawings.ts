import { readAsset, writeAsset } from "./bridge"

/**
 * The drawings a note's blocks point at.
 *
 * A port of the app's `lib/note/drawings.ts`, with one change: there a scene lives
 * in `workspace/drawings/<id>.excalidraw` and is read over IPC, here it lives in
 * `<note>.assets/<id>.excalidraw` — beside the note, like its pictures, so a note
 * and its diagrams are committed, moved and deleted together.
 *
 * Not a store with a framework behind it, for the app's own reason: a drawing is
 * opened from a block and from the slash menu, and both of those raise an event
 * rather than call a hook, because the dialog that answers it is mounted somewhere
 * else entirely. So this is a cache and two subscriptions.
 */

/** What Excalidraw's own `.excalidraw` file holds. Only the fields this app passes
 * back and forth are named; the rest travel with them. */
export type DrawingScene = {
  type: "excalidraw"
  version: number
  source: string
  elements: unknown[]
  appState: Record<string, unknown>
  files: Record<string, unknown>
}

export function emptyScene(): DrawingScene {
  return {
    type: "excalidraw",
    version: 2,
    source: "anote",
    elements: [],
    appState: {},
    files: {},
  }
}

/** The scene's file, and the picture of it beside it. The picture is what the two
 * previews render: neither can run Excalidraw, and one of them is a Node process. */
export const sceneFile = (id: string) => `${id}.excalidraw`
export const pictureFile = (id: string) => `${id}.svg`

/**
 * Scenes already read this session, so a note with a drawing in it does not go
 * back through the bridge every time the block re-renders — a theme change alone
 * re-renders every preview in the document.
 */
const cache = new Map<string, DrawingScene>()

/** Called when a scene changes, so previews of it redraw. */
const changed = new Set<(id: string) => void>()

/** Called when something asks for a drawing to be opened for editing. */
const opened = new Set<(id: string) => void>()

export function onDrawingChanged(listener: (id: string) => void): () => void {
  changed.add(listener)
  return () => changed.delete(listener)
}

/**
 * Subscribes to edit requests — what a block's Edit button raises and the note
 * pane answers by opening the dialog.
 *
 * An event rather than a callback passed down, because the button is inside a
 * node view several layers below any component that could have been handed one.
 */
export function onDrawingOpened(listener: (id: string) => void): () => void {
  opened.add(listener)
  return () => opened.delete(listener)
}

export function openDrawing(id: string): void {
  for (const listener of opened) listener(id)
}

export function newDrawingId(): string {
  return crypto.randomUUID()
}

/** What is already known about a drawing, without going to the host. */
export function peekDrawing(id: string): DrawingScene | undefined {
  return cache.get(id)
}

/** A drawing's scene, read once and then remembered. */
export async function loadDrawing(id: string): Promise<DrawingScene> {
  const cached = cache.get(id)
  if (cached) return cached

  let scene = emptyScene()
  try {
    const base64 = await readAsset(sceneFile(id))
    if (base64) {
      const text = new TextDecoder().decode(
        Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))
      )
      if (text.trim())
        scene = { ...emptyScene(), ...(JSON.parse(text) as object) }
    }
  } catch (error) {
    // A scene that will not parse is a file somebody edited by hand or a write
    // that was cut short. An empty canvas is recoverable and refusing to open the
    // note is not; the next save replaces the file.
    console.error("Could not read the drawing", error)
  }

  cache.set(id, scene)
  return scene
}

export async function saveDrawing(
  id: string,
  scene: DrawingScene,
  /** The picture, exported by whoever had Excalidraw loaded — see `exportPicture`
   * in `drawing-editor.tsx`. Always the light rendering, because the previews have
   * only the one. */
  svg: string
): Promise<void> {
  cache.set(id, scene)
  for (const listener of changed) listener(id)

  await writeAsset(sceneFile(id), base64Of(JSON.stringify(scene)))
  // Failing to write the picture is not failing the save: the scene is the record
  // and it is already down. What is lost is a diagram in a preview, which the next
  // save replaces.
  await writeAsset(pictureFile(id), base64Of(svg)).catch((error) => {
    console.error("Could not write the drawing's picture", error)
  })
}

/** UTF-8 text as base64, which is what the bridge carries. `btoa` alone throws on
 * anything outside Latin-1, and a scene holds whatever text was typed into it. */
function base64Of(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}
