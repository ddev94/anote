import { readFileSync } from "node:fs"
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

import {
  CONFIG_FILE,
  DEFAULT_CONFIG,
  isSharedAssetPath,
  legacyAssetsDirFor,
  parseConfig,
  type AnoteConfig,
} from "../config"
import type { NoteBlock } from "../protocol"

/**
 * The notes in a folder, as files.
 *
 * The MCP server's whole idea of the world. It runs outside VS Code — a process
 * spawned by whatever is doing the reading and writing — so unlike everything in
 * `src/host/`, `workspace.fs` is not available to it and `node:fs` is the only
 * filesystem there is. That is also its limit, and the one worth saying out loud:
 * a note on a remote, in a container or in a virtual filesystem is one VS Code
 * can read and this cannot.
 *
 * **Nothing here builds a path out of what arrives.** Every path from a tool call
 * goes through `pathOf`, which resolves it against the root and refuses anything
 * that lands outside — the same rule the note pages keep by never taking a
 * path off a URL at all. Here a path is what the caller has to name, so it is
 * checked rather than avoided.
 */
export class Workspace {
  /**
   * The root, and the workspace's `anote.config.json`.
   *
   * The config is read once, at startup, and not watched — unlike the extension
   * host's copy. This process is spawned per server and the editor restarts it
   * when the definition changes, which `mcp-provider.ts` makes it do on every
   * write to the config file: the reload is the restart, and a watcher here
   * would be a second mechanism for the same thing.
   */
  constructor(
    readonly root: string,
    readonly config: AnoteConfig = DEFAULT_CONFIG
  ) {}

  /**
   * A path from a tool call, as an absolute one inside the workspace.
   *
   * Two refusals, and they are different: outside the root is a caller reaching
   * for somebody's `.ssh`, and not a `.note` is a caller about to write a block
   * document over a source file.
   */
  pathOf(given: string): string {
    const full = resolve(this.root, given)
    const inside = relative(this.root, full)
    if (!inside || inside.startsWith("..") || isAbsolute(inside)) {
      throw new Refused(`Outside the notes folder: ${given}`)
    }
    if (!full.endsWith(".note")) {
      throw new Refused(`Not a note: ${given} — a note's name ends in .note`)
    }
    return full
  }

  /** The path a tool should name this file by. */
  nameOf(full: string): string {
    return relative(this.root, full).split(sep).join("/")
  }

  /** Every note under the root, in the order the filesystem gives them. */
  async notes(): Promise<string[]> {
    const found: string[] = []

    const walk = async (directory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory()) {
          // The notes' files, and the directories no note is ever kept in.
          if (entry.name === this.config.assets.dir) continue
          if (entry.name.endsWith(this.config.assets.dirSuffix)) continue
          if (SKIP.has(entry.name) || entry.name.startsWith(".")) continue
          await walk(join(directory, entry.name))
          continue
        }
        if (entry.name.endsWith(".note")) {
          found.push(this.nameOf(join(directory, entry.name)))
        }
      }
    }

    await walk(this.root)
    return found.sort()
  }

  /**
   * A note's blocks.
   *
   * Strict, unlike `parseNote` — which the previews use, and which answers an
   * unreadable file with an empty note because a preview is a read and a read
   * reports rather than refuses. This is the read that an edit is written back
   * from, and there the two are opposites: a file that did not parse must stop
   * the write, or a note nobody could read becomes a note nobody can recover.
   */
  async read(given: string): Promise<NoteBlock[]> {
    const text = await readFile(this.pathOf(given), "utf8")
    // What `New Note` writes, and what the editor treats as a note nobody has
    // typed into yet.
    if (!text.trim()) return []

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new Refused(
        `${given} is not readable as a note — its JSON does not parse. ` +
          `Open it in VS Code before anything writes over it.`
      )
    }
    if (!Array.isArray(parsed)) {
      throw new Refused(`${given} is not a note — a note is an array of blocks.`)
    }
    return parsed as NoteBlock[]
  }

  /** The note, written the way the editor writes it: one line of JSON, so an
   * edit from here and an edit from the editor produce the same kind of diff. */
  async write(given: string, blocks: NoteBlock[]): Promise<void> {
    const full = this.pathOf(given)
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, JSON.stringify(blocks), "utf8")
  }

  async exists(given: string): Promise<boolean> {
    try {
      await readFile(this.pathOf(given))
      return true
    } catch {
      return false
    }
  }

  /**
   * The files this note points at, as the paths the document holds.
   *
   * A listing of the note's blocks rather than of a directory, which is what the
   * shared assets directory forced and what should have been here anyway: with
   * one directory for the whole folder, `readdir` would answer a question about
   * one note with every file every note has ever had. The document is the only
   * thing that knows which of them are this note's.
   *
   * Only what is actually on disk, so the answer is a list of files rather than a
   * list of claims — a note may well point at a picture somebody has since
   * deleted, and saying so is the caller's business, not this line's.
   */
  async assets(given: string, blocks: NoteBlock[]): Promise<string[]> {
    const note = this.pathOf(given)
    const found: string[] = []

    for (const path of this.assetPathsIn(note, blocks)) {
      const full = this.assetPathOf(note, path)
      if (!full) continue
      try {
        await readFile(full)
        found.push(path)
      } catch {
        // Pointed at and not there, or the other half of a drawing's pair.
      }
    }
    return [...new Set(found)].sort()
  }

  /**
   * Every path a document could be holding a file under.
   *
   * Two kinds. A picture, clip or attachment keeps its path in `props.url`, which
   * is the path itself. A drawing keeps only its `drawingId`, and the two files
   * behind it — the scene and the picture exported from it — are named after that
   * id in whichever directory they were written to, so both candidates for both
   * are offered and `assets` above keeps the ones that exist.
   */
  private assetPathsIn(note: string, blocks: NoteBlock[]): string[] {
    const paths: string[] = []
    /* Both directories a drawing could be in, *as a document would spell them*:
       the shared one, and the note's own for a drawing made before that existed.
       Written this way so every path out of here is relative to the same thing —
       the note's directory — which is what `assetPathOf` can then resolve without
       a second rule. */
    const dirs = [
      this.config.assets.dir,
      legacyAssetsDirFor(note.split(sep).pop() ?? "note", this.config),
    ]

    const walk = (nodes: NoteBlock[]): void => {
      for (const node of nodes) {
        const url = node.props?.url
        if (typeof url === "string" && isStored(url)) paths.push(url)

        const id = node.props?.drawingId
        if (typeof id === "string" && /^[0-9a-z-]{1,64}$/i.test(id)) {
          for (const dir of dirs) {
            paths.push(`${dir}/${id}.excalidraw`, `${dir}/${id}.svg`)
          }
        }
        if (node.children) walk(node.children)
      }
    }

    walk(blocks)
    return paths
  }

  /**
   * Where a path a document holds is on disk, or "" for one that leaves the root.
   *
   * The same fork the editor and both previews make: a path with the assets
   * directory's name on the front is relative to the *root*, and one without is
   * relative to the *note's directory* — which is where a note written before that
   * directory existed keeps its files, and note that such a path carries its own
   * `<note>.assets/` on the front already.
   *
   * Checked against the root afterwards rather than trusted, because `props.url`
   * is a string in a file somebody could have written by hand.
   */
  private assetPathOf(note: string, path: string): string {
    const full = resolve(
      isSharedAssetPath(path, this.config) ? this.root : dirname(note),
      path
    )
    const inside = relative(this.root, full)
    return !inside || inside.startsWith("..") || isAbsolute(inside) ? "" : full
  }
}

/** Whether a URL is a path this extension stored, rather than something the note
 * merely points at — the same question `note-blocks.ts` asks on the host side. */
function isStored(url: string): boolean {
  if (!url || url.startsWith("/")) return false
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return false
  return !url.split("/").includes("..")
}

/**
 * The workspace's `anote.config.json`, if it has one.
 *
 * `node:fs` because that is all this process has — and everything that can go
 * wrong with reading it means the same thing here: the defaults. There is no
 * window to show a warning in and stdout carries the protocol, so a config that
 * does not parse is one line on stderr and no further comment.
 */
export function configIn(root: string): AnoteConfig {
  let text: string
  try {
    // Synchronous, and this is the one place in the file that is. It runs once
    // before the first line is read off stdin, and the alternative is a
    // top-level await in a CommonJS bundle.
    text = readFileSync(join(root, CONFIG_FILE), "utf8")
  } catch {
    return DEFAULT_CONFIG
  }

  try {
    const { config, problems } = parseConfig(
      text.trim() ? JSON.parse(text) : undefined
    )
    for (const problem of problems) {
      process.stderr.write(`anote mcp: ${CONFIG_FILE}: ${problem}\n`)
    }
    return config
  } catch {
    process.stderr.write(
      `anote mcp: ${CONFIG_FILE} does not parse as JSON — using the defaults\n`
    )
    return DEFAULT_CONFIG
  }
}

const SKIP = new Set(["node_modules", "dist", "out", "build"])

/** Something the caller asked for that this will not do. Its message is written
 * to be read by whatever asked — it is the answer, not a stack trace. */
export class Refused extends Error {}
