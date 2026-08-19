import {
  Component,
  StrictMode,
  useEffect,
  useRef,
  useState,
  type ErrorInfo,
  type ReactNode,
} from "react"
import { createRoot } from "react-dom/client"

import type { NoteBlock, NoteFormat, ToWebview } from "../protocol"
import { onMessage, send, settleUpload, useChannel, vsCodeChannel } from "./bridge"
import { NoteEditor } from "./editor"
import { claimEditorKeys } from "./shortcuts"
import { setTheme as rememberTheme } from "./theme"
/*
 * Deliberately not `@blocknote/core/fonts/inter.css`, which the app does import:
 * it inlines the whole Inter family into the bundle, and this editor is set in
 * `--vscode-font-family` so none of it would ever be drawn. It is 700kB of
 * stylesheet for a font nothing asks for.
 */
import "@blocknote/mantine/style.css"
import "./theme.css"

/* The channel, before anything can try to send down it. VS Code's own
   `postMessage`; the studio installs an HTTP one instead and mounts the same
   editor — see `bridge.ts`. */
useChannel(vsCodeChannel())

/** How long typing settles before the document is edited. The app writes a file
 * on this delay; here it makes the tab dirty, and one `WorkspaceEdit` per
 * keystroke would be one undo step per keystroke in VS Code's own stack. */
const EDIT_DELAY_MS = 300

function parse(text: string): NoteBlock[] {
  if (!text.trim()) return []
  try {
    const parsed: unknown = JSON.parse(text)
    return Array.isArray(parsed) ? (parsed as NoteBlock[]) : []
  } catch {
    // A half-written file is not a crash. Losing the text would be worse than
    // any alternative, so this reports and starts empty; the next edit replaces
    // it.
    send({ type: "failed", message: "That note could not be read as blocks." })
    return []
  }
}

/**
 * The webview.
 *
 * It holds no file and knows no path. What it has is the text the host gave it,
 * a URL pictures resolve against, and one channel — which is the same position
 * the app's renderer is in, and the reason its editor came over unchanged.
 */
function App() {
  const [loaded, setLoaded] = useState<{
    /** Bumped whenever the document is replaced from outside, to rebuild the
     * editor: BlockNote takes its content at construction and has no "load this
     * instead". */
    generation: number
    blocks: NoteBlock[]
    dirUri: string
    /** Which file these blocks came out of. The host converts a `.md` in both
     * directions, so what arrives here is blocks either way — this is only what
     * the editor takes features away for. */
    format: NoteFormat
  } | null>(null)
  const [theme, setTheme] = useState<"dark" | "light">("dark")

  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // Before anything is loaded, because a keystroke the workbench has already
  // acted on cannot be taken back.
  useEffect(() => claimEditorKeys(), [])

  useEffect(() => {
    const stop = onMessage((message: ToWebview) => {
      if (settleUpload(message)) return

      switch (message.type) {
        case "init":
          setTheme(message.theme)
          rememberTheme(message.theme)
          return setLoaded({
            generation: 0,
            blocks: parse(message.text),
            dirUri: message.dirUri,
            format: message.format,
          })

        case "external":
          // The document changed under the editor — a git checkout, an undo run
          // from outside this webview. The caret goes with the rebuild, which is
          // why the host is careful never to send this for an edit made here.
          return setLoaded((current) =>
            current
              ? {
                  ...current,
                  generation: current.generation + 1,
                  blocks: parse(message.text),
                }
              : current
          )

        case "theme":
          rememberTheme(message.theme)
          return setTheme(message.theme)
      }
    })

    // The host posts nothing until this arrives: a message sent before this
    // script ran is a message nobody hears.
    send({ type: "ready" })
    return stop
  }, [])

  if (!loaded) return null

  /*
   * No check for unsupported blocks here any more, and that is the point: the
   * editor folds them into a listing of themselves (`unsupported.tsx`) rather than
   * refusing the note, so a document with one unknown wrapper in it is a document
   * whose other seventy blocks are editable. What is left for the boundary below
   * is everything that is genuinely a fault.
   */
  return (
    <Boundary>
      <NoteEditor
        key={loaded.generation}
        initial={loaded.blocks}
        dirUri={loaded.dirUri}
        format={loaded.format}
        theme={theme}
        onChange={(blocks) => {
          clearTimeout(pending.current)
          pending.current = setTimeout(() => {
            send({ type: "edit", text: JSON.stringify(blocks) })
          }, EDIT_DELAY_MS)
        }}
      />
    </Boundary>
  )
}

/**
 * What the panel says when it cannot show the note.
 *
 * On the page rather than in a notification, because the panel is the thing the
 * user is looking at: a toast that has been dismissed leaves the same white
 * rectangle behind, and a note that will not open is a state to sit in and read,
 * not an event. The host is told as well — `failed` becomes a VS Code error
 * message — so the failure is also in the place VS Code keeps them.
 */
function Problem({
  title,
  detail,
  hint,
}: {
  title: string
  detail: string
  hint?: string
}) {
  useEffect(() => {
    send({ type: "failed", message: `${title}. ${detail}` })
  }, [title, detail])

  return (
    <div className="note-problem">
      <h1>{title}</h1>
      <p>{detail}</p>
      {hint ? <p className="note-problem-hint">{hint}</p> : null}
    </div>
  )
}

/**
 * Everything else that can throw while the note is on screen.
 *
 * The type check above catches the failure that is *predictable* from the
 * document. This catches the rest — a block whose props are the wrong shape,
 * Excalidraw failing to draw, a BlockNote version that reads a field differently
 * — and all of them have the same symptom without it, because a React tree that
 * throws during render unmounts, and an unmounted webview is a white panel.
 *
 * A class, because an error boundary is the one thing hooks still cannot be.
 */
class Boundary extends Component<
  { children: ReactNode },
  { failed: Error | null }
> {
  override state: { failed: Error | null } = { failed: null }

  static getDerivedStateFromError(failed: Error): { failed: Error } {
    return { failed }
  }

  override componentDidCatch(failed: Error, info: ErrorInfo): void {
    // The console as well as the panel: the component stack is the useful half
    // for whoever is fixing it, and it is too long to read on the page.
    console.error("The note could not be drawn", failed, info.componentStack)
  }

  override render(): ReactNode {
    const { failed } = this.state
    if (!failed) return this.props.children

    return (
      <Problem
        title="This note could not be drawn"
        detail={failed.message || String(failed)}
        hint="The file on disk has not been changed. Help → Toggle Developer Tools has the stack."
      />
    )
  }
}

const root = document.getElementById("root")
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>
  )
}
