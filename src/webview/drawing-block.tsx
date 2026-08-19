import { useEffect, useRef, useState } from "react"
import { createReactBlockSpec } from "@blocknote/react"

import {
  loadDrawing,
  onDrawingChanged,
  openDrawing,
  peekDrawing,
  type DrawingScene,
} from "./drawings"
import { currentTheme, onThemeChanged } from "./theme"

/**
 * A drawing in a note: an Excalidraw scene, held in the document as one block that
 * knows only the scene's id.
 *
 * The scene is a file of its own and this block carries the id — the same division
 * the app makes, and for the same reason: a note with five diagrams would otherwise
 * be five copies of Excalidraw's own JSON inside the file the editor rewrites on
 * every pause in the typing.
 *
 * The block draws an exported SVG rather than mounting a live canvas per drawing.
 * Excalidraw takes the wheel for zoom, so an editable canvas inside a scrolling
 * document is a scroll trap.
 */
export const DRAWING_BLOCK = "drawing"

export const drawingBlockSpec = createReactBlockSpec(
  {
    type: DRAWING_BLOCK,
    // One thing, not a container: there is nothing in it to put a caret in, and a
    // selection must not reach inside.
    content: "none",
    propSchema: { drawingId: { default: "" } },
  },
  {
    render: ({ block, editor }) => (
      <DrawingPreview
        drawingId={block.props.drawingId}
        // Only the block. The scene file is left alone, because this has to be
        // undoable and a delete that had already removed the file would come back
        // as an empty drawing.
        onRemove={() => editor.removeBlocks([block])}
      />
    ),
  }
)

function DrawingPreview({
  drawingId,
  onRemove,
}: {
  drawingId: string
  onRemove: () => void
}) {
  const canvas = useRef<HTMLDivElement>(null)
  /*
   * A drawing is exported with its own light or dark rendering — Excalidraw inverts
   * the strokes rather than tinting them — so the theme has to redraw every preview
   * in the document. Read from a module rather than a prop: this block is rendered
   * by BlockNote, several layers below anything that could hand it one.
   *
   * Getting this wrong is what a white background behind the drawing was papering
   * over: exported light on a dark editor, a diagram is black strokes nobody can
   * see.
   */
  const [theme, setBlockTheme] = useState(currentTheme)
  useEffect(() => onThemeChanged(setBlockTheme), [])

  // Seeded from the cache, so a drawing already read this session draws on the
  // first frame rather than flashing a placeholder.
  const [scene, setScene] = useState<DrawingScene | null>(
    () => peekDrawing(drawingId) ?? null
  )
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let live = true

    const read = () => {
      const cached = peekDrawing(drawingId)
      if (cached) return setScene(cached)
      void loadDrawing(drawingId).then((loaded) => {
        if (live) setScene(loaded)
      })
    }

    read()
    // The scene is edited in a dialog over the note, so what is on the page has to
    // follow it: the drawing is saved before the dialog closes, and this is what
    // puts the new version under it.
    const stop = onDrawingChanged((id) => {
      if (id === drawingId) read()
    })

    return () => {
      live = false
      stop()
    }
  }, [drawingId])

  const empty = !scene || scene.elements.length === 0

  useEffect(() => {
    if (empty) return
    let live = true

    void (async () => {
      // Only ever reached for a drawing with something in it. In the app this
      // `import()` is what keeps Excalidraw out of the launch bundle; here esbuild
      // has no code splitting turned on, so it is one bundle either way — the
      // shape is kept because turning splitting on is the optimisation, and this
      // is the line that would benefit from it.
      const { exportToSvg } = await import("@excalidraw/excalidraw")
      if (!live || !scene) return

      try {
        const svg = await exportToSvg({
          elements: scene.elements as Parameters<
            typeof exportToSvg
          >[0]["elements"],
          appState: {
            ...scene.appState,
            // Following the editor, unlike the copy written beside the scene for
            // the previews — those pages have only the one rendering.
            exportWithDarkMode: theme === "dark",
          },
          files: scene.files as Parameters<typeof exportToSvg>[0]["files"],
          exportPadding: 8,
        })
        if (!live) return

        /*
         * Its own intrinsic size is the scene's bounding box in pixels; the block
         * is as wide as the note, so the drawing scales to it rather than
         * overflowing a narrow pane.
         *
         * The attributes go and the style is set inline, rather than left to the
         * stylesheet: Excalidraw writes its own `style` on the root `<svg>`, and an
         * inline width beats any rule no matter how specific.
         */
        svg.removeAttribute("width")
        svg.removeAttribute("height")
        svg.style.width = "100%"
        svg.style.height = "auto"
        svg.style.maxWidth = "100%"

        // And the ratio spelled out rather than left for `height: auto` to infer
        // from the viewBox — when that inference does not happen the element takes
        // the full width with its height from elsewhere, and
        // `preserveAspectRatio` fits the scene to the height and centres it: a
        // diagram sitting small in the middle of a full-width block.
        const [, , vbWidth, vbHeight] = (svg.getAttribute("viewBox") ?? "")
          .split(/[\s,]+/)
          .map(Number)
        if (vbWidth && vbHeight && vbWidth > 0 && vbHeight > 0) {
          svg.style.aspectRatio = `${vbWidth} / ${vbHeight}`
        }
        canvas.current?.replaceChildren(svg)
        setFailed(false)
      } catch (error) {
        console.error("Could not draw the preview", error)
        if (live) setFailed(true)
      }
    })()

    return () => {
      live = false
    }
  }, [scene, empty, theme])

  return (
    <div className="note-drawing" data-drawing-id={drawingId}>
      <div
        className="note-drawing-canvas"
        onClick={() => openDrawing(drawingId)}
      >
        {empty || failed ? (
          <p className="note-drawing-placeholder">
            {failed
              ? "This drawing could not be drawn"
              : "Empty drawing — click to start"}
          </p>
        ) : (
          <div ref={canvas} />
        )}
      </div>

      {/* The buttons are this block's own; `contentEditable={false}` is what keeps
          a click on one out of the document's selection. */}
      <div className="note-drawing-toolbar" contentEditable={false}>
        <button type="button" onClick={() => openDrawing(drawingId)}>
          Edit
        </button>
        <button
          type="button"
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            onRemove()
          }}
        >
          Remove
        </button>
      </div>
    </div>
  )
}
