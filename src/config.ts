/**
 * `anote.config.json` — what a workspace gets to decide about ANote.
 *
 * One file at the root of a workspace folder, read when the extension activates
 * and re-read whenever it is written. It is deliberately *not* VS Code settings:
 * where notes live and what the folder beside them is called are facts about the
 * repository, not about the person looking at it, so they belong in the
 * repository and travel with a clone.
 *
 * **Nothing here throws.** A config is read at activation, and an extension that
 * refuses to start because a comma is in the wrong place is worse than one that
 * starts on its defaults and says so. Every value that does not check out falls
 * back to the default and leaves a line in `problems` for the caller to show.
 *
 * This module imports nothing — not `vscode`, not `node:fs`. The extension host
 * reads the file through `workspace.fs` (so a note in a container is reachable)
 * and the MCP server reads it through `node:fs` (because it has nothing else),
 * and both hand the parsed JSON to the same function below.
 */

export const CONFIG_FILE = "anote.config.json"

export const PREVIEW_THEMES = ["auto", "light", "dark"] as const

export type PreviewTheme = (typeof PREVIEW_THEMES)[number]

export type AnoteConfig = {
  /**
   * Where `New Note` puts a note when it was not aimed at a folder, and the root
   * the MCP server reads — relative to the workspace folder, `.` for the folder
   * itself.
   */
  notesDir: string
  newNote: {
    /** What the name box is prefilled with. */
    defaultName: string
  }
  assets: {
    /**
     * The one directory every note's files go in — under `notesDir`, named this.
     *
     * One pool rather than a directory per note, and the reason is a rename. The
     * old layout named the directory after the note (`Spec.note.assets`, beside
     * it), which meant the name was a *function of the filename*: renaming
     * `Spec.note` to `Design.note` in the Explorer left every picture in it
     * behind, silently, because every lookup had already moved on to
     * `Design.note.assets`. A fixed name cannot do that — a note may be renamed
     * and moved anywhere under the notes root and its files are still where the
     * document says they are.
     *
     * A path relative to this directory is what a document holds, prefixed with
     * this name (`anote.assets/diagram.png`), which is what lets both hosts tell
     * a path in the pool from one of the old per-note ones and go on reading
     * both.
     */
    dir: string
    /**
     * **Legacy, and read only.** What a note's *own* directory used to be
     * called: the note's full filename with this appended, beside it.
     * `Spec.note` → `Spec.note.assets`.
     *
     * Nothing is written there any more — `dir` above is where a dropped file
     * lands. It is still here, and still honoured everywhere a file is *read*,
     * because notes written before the pool existed hold paths into these
     * directories and a setting that stopped being read is a note whose pictures
     * went blank on an upgrade.
     */
    dirSuffix: string
  }
  preview: {
    /** The palette a page starts on, before anyone has pressed the toggle. */
    theme: PreviewTheme
    /** How often a note open in a browser asks whether it changed. Both surfaces
     * poll on it: a page reloads itself, and the studio reloads the note. */
    pollMs: number
    /**
     * The port the notes are served on, or 0 to let the OS pick a free one.
     *
     * **One port for both surfaces** — a note as a page, and the studio that edits
     * it (`host/note-server.ts`). It is still called `preview.port` because that is
     * what it was called when there was only the one, and renaming a key costs
     * everybody who has written it down more than the tidier name is worth.
     *
     * A fixed port is for the one thing an OS-picked one cannot do: survive a
     * restart as the same URL. It is bound on loopback either way, and *that* part
     * is not configurable — a page reachable from the network is somebody's own
     * writing on the network, and a studio reachable from the network is somebody
     * else's write access to it.
     */
    port: number
  }
  studio: {
    /**
     * Whether the notes may be opened as a page that can *write* them.
     *
     * The one switch in this file that turns a feature off rather than tuning it,
     * and it is here because the studio is the only thing in this extension that
     * accepts a write from outside the editor. A workspace that would rather that
     * did not exist says so once, in the repository, where it travels with a
     * clone — and the command then says the workspace has turned it off rather
     * than quietly doing nothing.
     *
     * Off is not a command that refuses: nothing is *mounted*, so `/`, `/api/…`,
     * `/files/…` and `/~/…` do not exist to be asked (`host/note-server.ts`). The
     * pages on the same port still work, because reading a note was never what this
     * switch was about.
     */
    enabled: boolean
  }
  mcp: {
    /** Whether the notes are offered to the editor's agent at all. */
    enabled: boolean
  }
}

export const DEFAULT_CONFIG: AnoteConfig = {
  notesDir: ".",
  newNote: { defaultName: "Untitled" },
  assets: { dir: "anote.assets", dirSuffix: ".assets" },
  preview: { theme: "auto", pollMs: 2000, port: 0 },
  studio: { enabled: true },
  mcp: { enabled: true },
}

export type ParsedConfig = {
  config: AnoteConfig
  /** Every value that was ignored, in words meant to be read by whoever wrote
   * the file. Empty for a config that checked out — including a missing one. */
  problems: string[]
}

/** How long a poll may be. Below the floor the page hammers the server; above
 * the ceiling the preview stops being a preview. */
const POLL_MS_RANGE = [250, 60_000] as const

/**
 * The config a workspace asked for, as far as it makes sense.
 *
 * `raw` is whatever `JSON.parse` returned — this is the boundary, so it is typed
 * `unknown` and every branch below is what turns that into the shape the rest of
 * the extension may assume. Pass `undefined` for a workspace with no config file
 * and get the defaults with nothing to report: not having one is the ordinary
 * case, not a problem.
 */
export function parseConfig(raw: unknown): ParsedConfig {
  const problems: string[] = []

  if (raw === undefined || raw === null) {
    return { config: DEFAULT_CONFIG, problems }
  }
  if (!isRecord(raw)) {
    problems.push(`${CONFIG_FILE} is not a JSON object — using the defaults.`)
    return { config: DEFAULT_CONFIG, problems }
  }

  const newNote = section(raw, "newNote", problems)
  const assets = section(raw, "assets", problems)
  const preview = section(raw, "preview", problems)
  const studio = section(raw, "studio", problems)
  const mcp = section(raw, "mcp", problems)

  return {
    config: {
      notesDir: notesDir(raw.notesDir, problems),
      newNote: {
        defaultName: name(
          newNote.defaultName,
          DEFAULT_CONFIG.newNote.defaultName,
          "newNote.defaultName",
          problems
        ),
      },
      assets: {
        dir: assetsDir(assets.dir, problems),
        dirSuffix: dirSuffix(assets.dirSuffix, problems),
      },
      preview: {
        theme: theme(preview.theme, problems),
        pollMs: integer(
          preview.pollMs,
          DEFAULT_CONFIG.preview.pollMs,
          POLL_MS_RANGE,
          "preview.pollMs",
          problems
        ),
        port: integer(
          preview.port,
          DEFAULT_CONFIG.preview.port,
          [0, 65535],
          "preview.port",
          problems
        ),
      },
      studio: {
        enabled: boolean(
          studio.enabled,
          DEFAULT_CONFIG.studio.enabled,
          "studio.enabled",
          problems
        ),
      },
      mcp: {
        enabled: boolean(
          mcp.enabled,
          DEFAULT_CONFIG.mcp.enabled,
          "mcp.enabled",
          problems
        ),
      },
    },
    problems,
  }
}

/**
 * Where every note's files go, relative to the notes root.
 *
 * The one place the pool's name is written down, so the two editors that write
 * into it, the two previews that read out of it and the MCP server that skips it
 * cannot drift apart on what it is called.
 */
export function assetsDirFor(config: AnoteConfig): string {
  return config.assets.dir
}

/**
 * What a path into the pool starts with — the directory's name and a slash.
 *
 * The slash is the whole point of having this rather than the name: a note
 * actually called `anote.assets.note` has a legacy directory named
 * `anote.assets.note.assets`, which starts with the pool's *name* and is not the
 * pool. Comparing against the prefix cannot make that mistake.
 */
export function assetsPrefixOf(config: AnoteConfig): string {
  return `${config.assets.dir}/`
}

/**
 * Whether a path a document holds points into the shared pool.
 *
 * The fork every read takes. A path that does is relative to the *notes root*; a
 * path that does not is relative to the note's own directory, which is where
 * notes written before the pool existed keep their files — see
 * `legacyAssetsDirFor`. Both go on working, and this is the one question that
 * tells them apart.
 */
export function isSharedAssetPath(path: string, config: AnoteConfig): boolean {
  return path.startsWith(assetsPrefixOf(config))
}

/**
 * **Legacy.** The directory a note written before the pool kept its own files
 * in — its full filename with `assets.dirSuffix` appended, beside it.
 *
 * Never written to any more. Still the answer to "where is this older note's
 * picture", which is why it did not simply go away: see `assets.dirSuffix`.
 */
export function legacyAssetsDirFor(
  noteFilename: string,
  config: AnoteConfig
): string {
  return `${noteFilename}${config.assets.dirSuffix}`
}

function section(
  raw: Record<string, unknown>,
  key: string,
  problems: string[]
): Record<string, unknown> {
  const value = raw[key]
  if (value === undefined) return {}
  if (isRecord(value)) return value
  problems.push(`${key} is not an object — using the defaults for it.`)
  return {}
}

/**
 * A folder inside the workspace, as a relative POSIX path.
 *
 * Refused rather than resolved when it points out: this value becomes the root
 * the MCP server reads and the folder a new note is written to, and a config
 * file naming `../../` is a repository handing an agent somebody's home
 * directory.
 */
function notesDir(value: unknown, problems: string[]): string {
  if (value === undefined) return DEFAULT_CONFIG.notesDir
  if (typeof value !== "string" || !value.trim()) {
    problems.push("notesDir is not a path — using the workspace folder.")
    return DEFAULT_CONFIG.notesDir
  }

  const path = value.trim().replace(/\\/g, "/").replace(/\/+$/, "")
  if (!path || path === ".") return DEFAULT_CONFIG.notesDir

  const absolute = path.startsWith("/") || /^[A-Za-z]:/.test(path)
  const escapes = path.split("/").some((segment) => segment === "..")
  if (absolute || escapes) {
    problems.push(
      `notesDir must stay inside the workspace folder: ${value} — using the workspace folder.`
    )
    return DEFAULT_CONFIG.notesDir
  }
  return path
}

/**
 * The suffix appended to a note's filename to name its directory.
 *
 * No separators, because it is joined onto a filename to build a path — the same
 * rule every other name this extension builds a path from is held to.
 */
function dirSuffix(value: unknown, problems: string[]): string {
  if (value === undefined) return DEFAULT_CONFIG.assets.dirSuffix
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]{1,32}$/.test(value)) {
    problems.push(
      `assets.dirSuffix must be 1–32 characters of letters, digits, dot, dash or underscore: ` +
        `${JSON.stringify(value)} — using "${DEFAULT_CONFIG.assets.dirSuffix}".`
    )
    return DEFAULT_CONFIG.assets.dirSuffix
  }
  return value
}

/**
 * The name of the pool every note's files go in.
 *
 * One segment, for the reason `dirSuffix` below is: it is joined onto the notes
 * root to build a path, and a config file naming `../../` is a repository
 * pointing an editor's writes at somebody's home directory. `.` and `..` are
 * refused by name — they pass the pattern and are not directories anybody meant.
 */
function assetsDir(value: unknown, problems: string[]): string {
  if (value === undefined) return DEFAULT_CONFIG.assets.dir
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9._-]{1,64}$/.test(value) ||
    value === "." ||
    value === ".."
  ) {
    problems.push(
      `assets.dir must be one directory name of 1–64 characters — letters, ` +
        `digits, dot, dash or underscore, and not "." or "..": ` +
        `${JSON.stringify(value)} — using "${DEFAULT_CONFIG.assets.dir}".`
    )
    return DEFAULT_CONFIG.assets.dir
  }
  return value
}

function theme(value: unknown, problems: string[]): PreviewTheme {
  if (value === undefined) return DEFAULT_CONFIG.preview.theme
  if (!PREVIEW_THEMES.includes(value as PreviewTheme)) {
    problems.push(
      `preview.theme must be one of ${PREVIEW_THEMES.join(", ")} — using ${DEFAULT_CONFIG.preview.theme}.`
    )
    return DEFAULT_CONFIG.preview.theme
  }
  return value as PreviewTheme
}

function integer(
  value: unknown,
  fallback: number,
  [low, high]: readonly [number, number],
  key: string,
  problems: string[]
): number {
  if (value === undefined) return fallback
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < low ||
    value > high
  ) {
    problems.push(
      `${key} must be a whole number between ${low} and ${high} — using ${fallback}.`
    )
    return fallback
  }
  return value
}

function boolean(
  value: unknown,
  fallback: boolean,
  key: string,
  problems: string[]
): boolean {
  if (value === undefined) return fallback
  if (typeof value !== "boolean") {
    problems.push(`${key} must be true or false — using ${fallback}.`)
    return fallback
  }
  return value
}

function name(
  value: unknown,
  fallback: string,
  key: string,
  problems: string[]
): string {
  if (value === undefined) return fallback
  if (typeof value !== "string" || !value.trim() || /[/\\]/.test(value)) {
    problems.push(
      `${key} must be a name with no path separators in it — using "${fallback}".`
    )
    return fallback
  }
  return value.trim()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
