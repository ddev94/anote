import { lazy, Suspense, useEffect, useRef, useState } from "react"

import {
  emptyScene,
  loadDrawing,
  saveDrawing,
  type DrawingScene,
} from "./drawings"
import { claimPaste } from "./shortcuts"

/**
 * The drawing editor: Excalidraw's canvas and its own toolbar, over the note.
 *
 * A dialog rather than a canvas embedded in the document, which is the app's
 * reasoning and holds here too: Excalidraw claims the wheel for zoom, so a canvas
 * in a scrolling page is something the page cannot be scrolled past — and a
 * drawing wants room a column of prose does not have.
 *
 * Hand-rolled overlay rather than a dialog component, because this extension has
 * no component library: the app reaches for its own shadcn `Dialog`, and bringing
 * that here would mean bringing Tailwind for one element.
 */

/**
 * What a shape drawn here looks like.
 *
 * Excalidraw is a whiteboard and its defaults say so: everything comes out
 * sketched, which reads as charm on a whiteboard and as a badly drawn rectangle on
 * a diagram of an API. Roughness 0 is the straightest of the three it offers.
 * Forced over whatever the scene was saved with, exactly as the theme is.
 */
const PLAIN_DEFAULTS = {
  currentItemRoughness: 0,
  currentItemFontSize: 20,
}

const Excalidraw = lazy(async () => {
  const module = await import("@excalidraw/excalidraw")
  /*
   * Excalidraw resolves its own fonts against this, and left unset it reaches
   * `esm.sh` — a network fetch, from a page whose CSP allows none, for a file the
   * package already ships. The host puts the directory's webview URI on `window`
   * before this bundle runs (`note-editor.ts`), and `esbuild.mjs` is what copies
   * the fonts there.
   */
  window.EXCALIDRAW_ASSET_PATH = window.EXCALIDRAW_ASSET_PATH ?? "./"
  return { default: module.Excalidraw }
})

type ExcalidrawApi = {
  getSceneElements: () => readonly unknown[]
  getAppState: () => Record<string, unknown>
  getFiles: () => Record<string, unknown>
}

/**
 * The scene as Excalidraw itself would write it to a `.excalidraw` file.
 *
 * **This is what a scene has to go through in both directions, and the reason is
 * a bug it caused.** `getAppState()` hands back the editor's whole live state —
 * 89 keys, of which Excalidraw's own file format keeps four (`gridSize`,
 * `gridStep`, `gridModeEnabled`, `viewBackgroundColor`; the rest are marked
 * unexportable in its `APP_STATE_STORAGE_CONF`). Writing all 89 down and handing
 * them back as `initialData` was doing two things wrong, and one of them was
 * fatal:
 *
 * `collaborators` is a `Map`. `JSON.stringify` renders a Map as `{}`, and
 * `restoreAppState` prefers any supplied value over its default — so a reopened
 * scene came up with a plain object where Excalidraw expects a Map, and the
 * first `collaborators.size` or `.forEach` on the render path threw. React
 * unmounted the subtree and left the empty dialog behind: a drawing was fine the
 * first time and a black rectangle every time after, because the first time
 * there was no file yet.
 *
 * (The other, harmless by comparison: `width`, `height`, `offsetTop` and
 * `offsetLeft` are the *previous* window's measurements. Those `restore` already
 * drops, being absent from `getDefaultAppState`.)
 *
 * Run on the way in as well as on the way out, because every scene already saved
 * carries the bad state — fixing only the write would leave those drawings
 * broken until someone opened one, which is the thing that crashes.
 */
async function persistable(scene: DrawingScene): Promise<DrawingScene> {
  const { serializeAsJSON } = await import("@excalidraw/excalidraw")
  const written = serializeAsJSON(
    scene.elements as Parameters<typeof serializeAsJSON>[0],
    scene.appState as Parameters<typeof serializeAsJSON>[1],
    scene.files as Parameters<typeof serializeAsJSON>[2],
    "local"
  )
  // `source` is Excalidraw's own export marker; this app's files say who wrote
  // them, as they did before.
  return { ...(JSON.parse(written) as DrawingScene), source: "anote" }
}

export function DrawingEditor({
  drawingId,
  theme,
  onClose,
}: {
  drawingId: string
  theme: "dark" | "light"
  onClose: () => void
}) {
  const [initial, setInitial] = useState<DrawingScene | null>(null)
  const [saving, setSaving] = useState(false)
  const api = useRef<ExcalidrawApi | null>(null)
  const canvas = useRef<HTMLDivElement | null>(null)

  // For as long as the canvas is up, and no longer: in the note underneath, the
  // workbench's own paste is the one that should run. See `shortcuts.ts`.
  useEffect(() => claimPaste(() => canvas.current), [])

  useEffect(() => {
    let cancelled = false
    // Through `persistable` before it is ever handed to Excalidraw: the scene on
    // disk may have been written by the build that saved all 89 appState keys.
    // The wait costs nothing — it is the same chunk the canvas below is already
    // loading.
    void loadDrawing(drawingId)
      .then(persistable)
      .then((scene) => {
        if (!cancelled) setInitial(scene)
      })
      .catch((error) => {
        console.error("Could not open the drawing", error)
        if (!cancelled) setInitial(emptyScene())
      })
    return () => {
      cancelled = true
    }
  }, [drawingId])

  /**
   * Saves and closes.
   *
   * The picture is exported here rather than in the block, because this is the one
   * place every save goes through, and because the block's own export follows what
   * is on screen while the previews have only the one rendering. So: always light,
   * and always from the scene being written, so the two files cannot disagree.
   */
  async function save() {
    const current = api.current
    if (!current || saving) return onClose()

    setSaving(true)
    const live: DrawingScene = {
      ...emptyScene(),
      elements: [...current.getSceneElements()],
      appState: current.getAppState(),
      files: current.getFiles(),
    }

    try {
      const { exportToSvg } = await import("@excalidraw/excalidraw")
      // The picture is drawn from the live state rather than the trimmed one:
      // an export reads `export*` keys that a file is not meant to keep.
      const svg = await exportToSvg({
        elements: live.elements as Parameters<
          typeof exportToSvg
        >[0]["elements"],
        appState: { ...live.appState, exportWithDarkMode: false },
        files: live.files as Parameters<typeof exportToSvg>[0]["files"],
        exportPadding: 8,
      })
      svg.removeAttribute("width")
      svg.removeAttribute("height")
      svg.style.width = "100%"
      svg.style.height = "auto"

      await saveDrawing(drawingId, await persistable(live), svg.outerHTML)
    } catch (error) {
      console.error("Could not save the drawing", error)
    } finally {
      setSaving(false)
      onClose()
    }
  }

  return (
    <div className="drawing-overlay" role="dialog" aria-label="Drawing">
      <div className="drawing-dialog">
        <header className="drawing-dialog-head">
          <span>Drawing</span>
          <span className="drawing-dialog-actions">
            <button type="button" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button
              type="button"
              className="drawing-dialog-save"
              onClick={() => void save()}
              disabled={saving}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </span>
        </header>

        <div className="drawing-canvas" ref={canvas}>
          {initial === null ? (
            <p className="drawing-loading">Loading…</p>
          ) : (
            <Suspense fallback={<p className="drawing-loading">Loading…</p>}>
              <Excalidraw
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                excalidrawAPI={(instance: any) => {
                  api.current = instance as ExcalidrawApi
                }}
                // Excalidraw drops a paste whose focus is outside its container,
                // and a canvas opened from the slash menu leaves the caret in the
                // note — so the dialog takes the focus with it.
                autoFocus
                initialData={{
                  elements: initial.elements as never,
                  appState: {
                    ...initial.appState,
                    ...PLAIN_DEFAULTS,
                    // The studio's, not the drawing's: a scene saved in one theme
                    // opens in whichever the editor is on now.
                    theme,
                  } as never,
                  files: initial.files as never,
                  scrollToContent: true,
                }}
                theme={theme}
              />
            </Suspense>
          )}
        </div>
      </div>
    </div>
  )
}
