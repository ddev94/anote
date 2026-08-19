import {
  StrictMode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { createRoot } from "react-dom/client"

import type { NoteBlock } from "../protocol"
import { READ, type NoteEntry, type NoteResult } from "../studio-api"
import type { PreviewTheme } from "../config"
import { useChannel } from "../webview/bridge"
import { NoteEditor } from "../webview/editor"
import { setTheme as rememberTheme } from "../webview/theme"
import {
  boot,
  createNote,
  listNotes,
  noteInUrl,
  noteVersion,
  readNote,
  rememberNoteInUrl,
  Refused,
  saveNote,
} from "./api"
import { studioChannel } from "./channel"
import { Sidebar } from "./sidebar"
/* The same two stylesheets the webview loads, in the same order — the editor's
   own, and then this extension's overrides of it. `studio.css` is third because it
   is the one that has to supply the `--vscode-*` values the second one is written
   against; see its own header. */
import "@blocknote/mantine/style.css"
import "../webview/theme.css"
import "./studio.css"

/**
 * The studio — the notes folder, open in a browser tab.
 *
 * The editor on this page is `src/webview/editor.tsx`, unchanged and not forked:
 * the same BlockNote schema, the same slash menu, the same drawings and tables and
 * paste handling as the tab inside VS Code. That is the whole point of the exercise
 * and it cost two files — `studio/channel.ts`, which answers the editor's messages
 * out of `fetch` calls, and `studio/studio.css`, which supplies the palette VS Code
 * would have. Everything in *this* file is what a webview did not have to think
 * about because VS Code was doing it: which note is open, when to save it, and what
 * to do when the file changed underneath.
 *
 * What it is not is a second editor for the same file with its own idea of the
 * truth. Every save says which version it is replacing and the server refuses one
 * that has moved on (`saveNote`), which is the only reason it is safe to have a
 * note open here and in a VS Code tab at the same time.
 */

/** How long typing settles before the note is saved. Longer than the webview's
 * 300ms, which only has to make a tab dirty — this is a write to a file over a
 * socket, and the version check means a save is never a lost keystroke, only a
 * later one. */
const SAVE_DELAY_MS = 500

/** Where the reader's light/dark choice is kept. Namespaced, because the origin is
 * a loopback port and everything else that ever binds one shares it — the served
 * preview keeps its own choice under a neighbouring key. */
const THEME_KEY = "anote.studio.theme"

/**
 * Which note the editor's own messages are about.
 *
 * Module-level, and it is the one piece of state that has to be: the channel is
 * installed once, before React mounts, and a drawing saving its scene from three
 * layers inside BlockNote has no way to be told which note it is in. The app below
 * keeps it in step with what it opens.
 */
let openNote: string | null = null

/** The page's own banner, subscribed to by the app. A `Set` because `StrictMode`
 * mounts the effect twice and a single slot would be left holding the one that was
 * torn down. */
const failures = new Set<(message: string) => void>()

useChannel(
  studioChannel({
    note: () => openNote,
    onFailed: (message) => {
      for (const listener of failures) listener(message)
    },
  })
)

/** The note the editor is drawing, and everything the save path needs to know
 * about it. */
type Open = {
  note: NoteResult
  blocks: NoteBlock[]
  /** Bumped to rebuild the editor: BlockNote takes its content at construction and
   * has no "load this instead". The same trick the webview's `generation` is. */
  generation: number
}

/** What the header says about the note's state on disk. */
type Save = "saved" | "typing" | "saving"

function App() {
  const [notes, setNotes] = useState<NoteEntry[]>([])
  const [open, setOpen] = useState<Open | null>(null)
  const [save, setSave] = useState<Save>("saved")
  const [problem, setProblem] = useState<string | null>(null)
  /** A save the server refused because the file moved on, with the version it is
   * actually at — the one failure the reader has a real choice about. */
  const [clash, setClash] = useState<{ problem: string; version: string } | null>(
    null
  )
  const [choice, setChoice] = useState<PreviewTheme>(savedTheme() ?? boot.theme)
  const dark = useDark(choice)

  /* The save path runs from a timeout and from the poll, so what it needs is in
     refs rather than in the render's closure: `version` is what a save is checked
     against, and `pending` is the text that has not reached the file yet. */
  const version = useRef("")
  const pending = useRef<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const path = useRef<string | null>(null)

  useEffect(() => {
    document.documentElement.dataset.theme = choice
    // The drawing block reads this rather than a context — Excalidraw inverts
    // strokes for a dark export, so it has to know. See `webview/theme.ts`.
    rememberTheme(dark ? "dark" : "light")
  }, [choice, dark])

  useEffect(() => {
    const banner = (message: string) => setProblem(message)
    failures.add(banner)
    return () => void failures.delete(banner)
  }, [])

  /** Everything the sidebar shows, and the poll that keeps it honest about notes
   * made in VS Code while the tab was open. */
  const refresh = useCallback(async () => {
    try {
      setNotes(await listNotes())
    } catch (error) {
      setProblem(reason(error, "Could not list the notes."))
    }
  }, [])

  /**
   * The pending text, written now.
   *
   * Every path that can lose an edit goes through this: the debounce firing, a
   * different note being opened, the tab being hidden, and `⌘S`. A save that is
   * refused for the version keeps the text in hand and raises the clash bar, so
   * nothing is dropped on the floor by a failure either.
   */
  const flush = useCallback(async () => {
    clearTimeout(timer.current)
    const text = pending.current
    const note = path.current
    if (text === null || !note) return

    pending.current = null
    setSave("saving")
    try {
      version.current = await saveNote(note, text, version.current)
      setSave(pending.current === null ? "saved" : "typing")
    } catch (error) {
      pending.current = text
      setSave("typing")
      if (error instanceof Refused && error.version) {
        setClash({ problem: error.message, version: error.version })
        return
      }
      setProblem(reason(error, "Could not save that."))
    }
  }, [])

  const show = useCallback(
    async (next: string) => {
      /* The text that has not been saved goes first, before the note it belongs to
         is swapped out from under it — otherwise clicking away from a note is how
         the last half-second of typing is lost. And if it did not go through, this
         does not either: the bar `flush` raised is asking a question, and answering
         it by opening another note would be dropping the text on the floor. */
      await flush()
      if (pending.current !== null) return

      try {
        const note = await readNote(next)
        openNote = note.path
        path.current = note.path
        version.current = note.version
        pending.current = null
        setClash(null)
        setProblem(null)
        setSave("saved")
        setOpen((was) => ({
          note,
          blocks: parse(note.text),
          generation: (was?.generation ?? 0) + 1,
        }))
        rememberNoteInUrl(note.path)
      } catch (error) {
        setProblem(reason(error, `Could not open ${next}.`))
      }
    },
    [flush]
  )

  // The first load: the notes, and whichever one the URL or the command asked for.
  useEffect(() => {
    void refresh()
    const wanted = noteInUrl()
    if (wanted) void show(wanted)
  }, [refresh, show])

  /**
   * The poll — whether the note open here changed somewhere else.
   *
   * The same mechanism the served preview uses and the same reason: a browser has
   * no channel to be told. What it does about it is different, because this page can
   * have unsaved text of its own — so a note that moved on while nothing is pending
   * is simply reloaded, and one that moved on while something *is* pending raises
   * the clash bar rather than choosing for the reader.
   */
  useEffect(() => {
    const note = open?.note.path
    if (!note) return

    const id = setInterval(() => {
      void (async () => {
        try {
          const now = await noteVersion(note)
          if (!now || now === version.current || note !== path.current) return
          if (pending.current !== null) {
            return setClash({
              problem: `${nameOf(note)} changed underneath the studio.`,
              version: now,
            })
          }
          const fresh = await readNote(note)
          version.current = fresh.version
          setOpen((was) =>
            was && was.note.path === note
              ? {
                  note: fresh,
                  blocks: parse(fresh.text),
                  generation: was.generation + 1,
                }
              : was
          )
        } catch {
          /* A poll is a courtesy; the reader is told when a *save* fails, which is
             the moment it matters. Left silent so a window that has just closed
             does not put a banner over the note. */
        }
      })()
    }, boot.pollMs)
    return () => clearInterval(id)
  }, [open?.note.path])

  // New notes made in VS Code, and ones this tab made in another window. Five
  // times the note's own interval: a listing is a search, and the sidebar being a
  // few seconds behind costs nothing.
  useEffect(() => {
    const id = setInterval(() => void refresh(), Math.max(boot.pollMs * 5, 5000))
    return () => clearInterval(id)
  }, [refresh])

  /* `⌘S`, and the tab going away. Neither is needed for the file to be written —
     the debounce is half a second — and both are what somebody expects to work,
     and the difference between "it saves" and "I think it saves". */
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault()
        void flush()
      }
    }
    const hidden = () => {
      if (document.visibilityState === "hidden") void flush()
    }
    document.addEventListener("keydown", keys)
    document.addEventListener("visibilitychange", hidden)
    window.addEventListener("pagehide", hidden)
    return () => {
      document.removeEventListener("keydown", keys)
      document.removeEventListener("visibilitychange", hidden)
      window.removeEventListener("pagehide", hidden)
    }
  }, [flush])

  const create = useCallback(
    async (wanted: string) => {
      try {
        const made = await createNote(wanted)
        await refresh()
        await show(made.path)
      } catch (error) {
        setProblem(reason(error, `Could not create ${wanted}.`))
      }
    },
    [refresh, show]
  )

  return (
    <div className="studio">
      <Sidebar
        notes={notes}
        current={open?.note.path ?? null}
        root={boot.root}
        onOpen={(next) => void show(next)}
        onCreate={(wanted) => void create(wanted)}
      />

      <main className="studio-main">
        <header className="studio-head">
          <div className="studio-title">
            {open ? (
              <>
                <strong>{open.note.name}</strong>
                <span className="studio-path">{open.note.path}</span>
              </>
            ) : (
              <strong>ANote Studio</strong>
            )}
          </div>

          <span className={`studio-state is-${save}`}>
            {open ? SAID[save] : ""}
          </span>

          {/* The pair to the **Edit** link a page carries — the same port, the
              other surface. A plain link, and it saves first: the page is rendered
              from the file, so following this with half a second of typing still in
              hand would be reading a note that is a keystroke behind. */}
          {open ? (
            <a
              className="studio-theme studio-page"
              href={`/${READ}/${open.note.path
                .split("/")
                .map(encodeURIComponent)
                .join("/")}`}
              title="Read it as a page — finished HTML, nothing to run"
              onClick={() => void flush()}
            >
              Open as page
            </a>
          ) : null}

          <button
            className="studio-theme"
            type="button"
            title={
              choice === "auto"
                ? "Following your browser"
                : `Always ${choice}`
            }
            onClick={() => {
              const next = NEXT_THEME[choice]
              setChoice(next)
              try {
                localStorage.setItem(THEME_KEY, next)
              } catch {
                // A private window, or storage blocked. The switch still works for
                // this page; it just will not be remembered.
              }
            }}
          >
            {choice === "auto" ? "Auto" : choice === "dark" ? "Dark" : "Light"}
          </button>
        </header>

        {problem ? (
          <div className="studio-bar is-problem" role="alert">
            <span>{problem}</span>
            <button type="button" onClick={() => setProblem(null)}>
              Dismiss
            </button>
          </div>
        ) : null}

        {clash ? (
          <div className="studio-bar is-clash" role="alert">
            <span>
              {clash.problem} Loading it discards what you have typed here.
            </span>
            <button
              type="button"
              onClick={() => {
                setClash(null)
                pending.current = null
                if (path.current) void show(path.current)
              }}
            >
              Load the newer note
            </button>
            <button
              type="button"
              onClick={() => {
                /* Written against the version the file is actually at, which is
                   what makes this an overwrite the reader chose rather than one
                   the studio did quietly. */
                version.current = clash.version
                setClash(null)
                void flush()
              }}
            >
              Keep mine
            </button>
          </div>
        ) : null}

        {open ? (
          <div className="studio-note">
            <NoteEditor
              key={open.generation}
              initial={open.blocks}
              dirUri={open.note.dirUrl}
              /* The studio serves `.note` files and only those — `studio-routes.ts`
                 refuses a path that does not end in one — so the editor it mounts
                 is the whole editor. A markdown file is opened in VS Code's own
                 tab (`note-editor.ts`) and never here. */
              format="note"
              theme={dark ? "dark" : "light"}
              onChange={(blocks) => {
                pending.current = JSON.stringify(blocks)
                setSave("typing")
                clearTimeout(timer.current)
                timer.current = setTimeout(() => void flush(), SAVE_DELAY_MS)
              }}
            />
          </div>
        ) : (
          <div className="studio-blank">
            <p>Pick a note on the left, or make one with +.</p>
            <p className="studio-blank-hint">
              This is the same editor as the one in VS Code, on the same files —
              what you type here is written to the workspace.
            </p>
          </div>
        )}
      </main>
    </div>
  )
}

const SAID: Record<Save, string> = {
  saved: "Saved",
  typing: "Unsaved",
  saving: "Saving…",
}

const NEXT_THEME: Record<PreviewTheme, PreviewTheme> = {
  auto: "light",
  light: "dark",
  dark: "auto",
}

/**
 * Whether the page is being painted dark, which the editor needs as one of two
 * words rather than as the three the reader gets to choose from.
 *
 * `auto` is the browser's answer, so it is subscribed to: a reader whose OS flips
 * at sunset gets the editor and its drawings flipped with it, without a reload.
 */
function useDark(choice: PreviewTheme): boolean {
  const query = useMemo(
    () => window.matchMedia("(prefers-color-scheme: dark)"),
    []
  )
  const [system, setSystem] = useState(query.matches)

  useEffect(() => {
    const listener = (event: MediaQueryListEvent) => setSystem(event.matches)
    query.addEventListener("change", listener)
    return () => query.removeEventListener("change", listener)
  }, [query])

  return choice === "auto" ? system : choice === "dark"
}

function savedTheme(): PreviewTheme | null {
  try {
    const saved = localStorage.getItem(THEME_KEY)
    return saved === "auto" || saved === "light" || saved === "dark"
      ? saved
      : null
  } catch {
    // Storage refused — the page is still readable in whichever theme the browser
    // is in.
    return null
  }
}

/** The blocks in a note's text. Empty for a note nobody has typed into, and for one
 * that will not parse: the server has already refused to *save* anything that does
 * not, so a file in that state was written by hand, and an editor that opens on it
 * is more use than a page that refuses to. */
function parse(text: string): NoteBlock[] {
  if (!text.trim()) return []
  try {
    const parsed: unknown = JSON.parse(text)
    return Array.isArray(parsed) ? (parsed as NoteBlock[]) : []
  } catch {
    return []
  }
}

function nameOf(path: string): string {
  return (path.split("/").pop() ?? path).replace(/\.note$/, "")
}

function reason(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

const root = document.getElementById("root")
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>
  )
}
