import { readFileSync } from "node:fs"
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

import {
  CONFIG_FILE,
  DEFAULT_CONFIG,
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

  /** The directory a note's own files are in — `assets.dirSuffix` appended to
   * the note, the same rule the editor writes them by. Takes whichever form of
   * the note's name the caller has, since it only ever appends. */
  assetsDir(note: string): string {
    return `${note}${this.config.assets.dirSuffix}`
  }

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
          // A note's own files, and the directories no note is ever kept in.
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

  /** What is in the note's own `<name>.note.assets/` — the pictures, clips and
   * drawings it points at. */
  async assets(given: string): Promise<string[]> {
    const full = this.pathOf(given)
    try {
      return (await readdir(this.assetsDir(full))).sort()
    } catch {
      return []
    }
  }
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
