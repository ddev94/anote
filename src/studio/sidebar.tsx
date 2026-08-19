import { useMemo, useState, type ReactNode } from "react"

import type { NoteEntry } from "../studio-api"

/**
 * The notes down the left — the one part of the studio that is not a port of
 * something.
 *
 * The desktop app this extension comes from draws a tree like this and the
 * extension deliberately does not: in VS Code the Explorer *is* the tree, so
 * building a second one would have been a worse copy of something already on
 * screen (see the header of `host/extension.ts`). In a browser tab there is no
 * Explorer, and a notes app with no way to see the notes is not one — so here the
 * tree comes back, as the smallest thing that answers "which note am I reading and
 * what else is there".
 *
 * What it will not do is rename, move or delete. That is the same line the rest of
 * the extension holds: those are the Explorer's, and a second half-built file
 * manager on a loopback port is not worth what it would cost to be trusted with
 * them. Creating a note is here because a sidebar with no `+` sends somebody back
 * to VS Code to do the one thing they came here to start.
 */

/** A directory in the tree, or a note in it. Built from the paths rather than
 * fetched: the server answers with a flat sorted list, which is the only thing it
 * can honestly say — a folder holding no notes is not a folder the studio has any
 * business showing. */
type Node =
  | { kind: "note"; name: string; path: string }
  | { kind: "folder"; name: string; path: string; children: Node[] }

function tree(notes: NoteEntry[]): Node[] {
  const roots: Node[] = []

  for (const note of notes) {
    const parts = note.path.split("/")
    const file = parts.pop()
    if (!file) continue

    // Down the directories, making the ones that are not there yet.
    let level = roots
    let walked = ""
    for (const part of parts) {
      walked = walked ? `${walked}/${part}` : part
      const path = walked
      let folder = level.find(
        (node): node is Extract<Node, { kind: "folder" }> =>
          node.kind === "folder" && node.path === path
      )
      if (!folder) {
        folder = { kind: "folder", name: part, path, children: [] }
        level.push(folder)
      }
      level = folder.children
    }
    level.push({ kind: "note", name: note.name, path: note.path })
  }

  /** Folders first and then notes, each alphabetically — the order a file tree is
   * read in, and stable across a poll that returns the same notes in the same
   * order anyway. */
  const order = (nodes: Node[]): Node[] => {
    for (const node of nodes) if (node.kind === "folder") order(node.children)
    return nodes.sort((left, right) =>
      left.kind === right.kind
        ? left.name.localeCompare(right.name)
        : left.kind === "folder"
          ? -1
          : 1
    )
  }
  return order(roots)
}

export function Sidebar({
  notes,
  current,
  root,
  onOpen,
  onCreate,
}: {
  notes: NoteEntry[]
  current: string | null
  /** `notesDir` — what the folder the studio is open on is called. */
  root: string
  onOpen: (path: string) => void
  /** The path typed into the `+` row, relative to the notes root. Resolved by the
   * caller, which is the one that knows whether it worked. */
  onCreate: (path: string) => void
}) {
  const [query, setQuery] = useState("")
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set())
  /** The `+` row: a string while it is open, so an empty name is still an open
   * box rather than a closed one. */
  const [naming, setNaming] = useState<string | null>(null)

  const matching = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return notes
    return notes.filter(
      (note) =>
        note.name.toLowerCase().includes(needle) ||
        note.path.toLowerCase().includes(needle)
    )
  }, [notes, query])

  const nodes = useMemo(() => tree(matching), [matching])

  const rows = (level: Node[], depth: number): ReactNode =>
    level.map((node) =>
      node.kind === "folder" ? (
        <div key={`folder:${node.path}`}>
          <button
            className="studio-row studio-folder"
            style={{ paddingLeft: `${0.5 + depth * 0.75}rem` }}
            type="button"
            aria-expanded={!closed.has(node.path)}
            onClick={() =>
              setClosed((was) => {
                const next = new Set(was)
                if (!next.delete(node.path)) next.add(node.path)
                return next
              })
            }
          >
            <span className="studio-twist" aria-hidden="true">
              {closed.has(node.path) ? "›" : "⌄"}
            </span>
            <span className="studio-name">{node.name}</span>
          </button>
          {/* Hidden rather than unmounted, so folding a folder does not lose the
              fold state of everything inside it. */}
          {closed.has(node.path) ? null : rows(node.children, depth + 1)}
        </div>
      ) : (
        <button
          key={`note:${node.path}`}
          className={`studio-row studio-note${node.path === current ? " is-open" : ""}`}
          style={{ paddingLeft: `${0.5 + depth * 0.75}rem` }}
          type="button"
          title={node.path}
          onClick={() => onOpen(node.path)}
        >
          <span className="studio-twist" aria-hidden="true">
            ·
          </span>
          <span className="studio-name">{node.name}</span>
        </button>
      )
    )

  return (
    <nav className="studio-sidebar" aria-label="Notes">
      <header className="studio-sidebar-head">
        <span className="studio-root" title={`notesDir: ${root}`}>
          {root === "." ? "Notes" : root}
        </span>
        <button
          className="studio-new"
          type="button"
          title="New note"
          aria-label="New note"
          onClick={() => setNaming((was) => (was === null ? "" : null))}
        >
          +
        </button>
      </header>

      <input
        className="studio-filter"
        type="search"
        placeholder="Find a note"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />

      {naming === null ? null : (
        <input
          className="studio-naming"
          autoFocus
          placeholder="Name, or a path — Enter to create"
          value={naming}
          onChange={(event) => setNaming(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") return setNaming(null)
            if (event.key !== "Enter") return
            const name = naming.trim()
            if (!name) return setNaming(null)
            // `.note` is the extension the whole extension is about; typing it is
            // allowed and forgetting it is the ordinary case.
            onCreate(name.endsWith(".note") ? name : `${name}.note`)
            setNaming(null)
          }}
        />
      )}

      <div className="studio-tree">
        {notes.length === 0 ? (
          <p className="studio-empty">
            No notes here yet. <strong>+</strong> makes one.
          </p>
        ) : matching.length === 0 ? (
          <p className="studio-empty">Nothing matching “{query}”.</p>
        ) : (
          rows(nodes, 0)
        )}
      </div>
    </nav>
  )
}
