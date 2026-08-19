import * as vscode from "vscode"

import {
  CONFIG_FILE,
  DEFAULT_CONFIG,
  parseConfig,
  type AnoteConfig,
} from "../config"

/**
 * Every workspace folder's `anote.config.json`, kept current.
 *
 * Per folder rather than per window, because a multi-root window is several
 * repositories and each one gets to say where its own notes are. Everything that
 * needs a setting asks with the note it is about — `configs.for(uri)` — and gets
 * the config of the folder that note is in; a question about no note in
 * particular gets the first folder's, which in the ordinary one-folder window is
 * the only answer there is.
 *
 * The file is watched. Writing it is meant to be how the setting changes, not a
 * reason to reload the window: the previews redraw and the MCP servers are
 * re-offered on the event this fires.
 */
export class Configs implements vscode.Disposable {
  private readonly byFolder = new Map<string, AnoteConfig>()
  private readonly changed = new vscode.EventEmitter<void>()
  private readonly disposables: vscode.Disposable[] = []

  /** Fired after a config file was written, deleted, or a folder was added or
   * removed — by which time `for()` already answers with the new one. */
  readonly onDidChange = this.changed.event

  constructor() {
    /* The config file only ever counts at the root of a workspace folder, but
       the watcher is the folder-wide pattern: a glob rooted at each folder is a
       watcher per folder to rebuild whenever the folders change, and the reload
       below discards a hit that was not at a root anyway. */
    const watcher = vscode.workspace.createFileSystemWatcher(`**/${CONFIG_FILE}`)
    const reload = () => void this.reload()

    this.disposables.push(
      watcher,
      this.changed,
      watcher.onDidCreate(reload),
      watcher.onDidChange(reload),
      watcher.onDidDelete(reload),
      vscode.workspace.onDidChangeWorkspaceFolders(reload)
    )
  }

  /**
   * The config that governs a resource — the note's own folder's, or the first
   * folder's for a question that names no note.
   *
   * Never undefined: a folder with no config file has the defaults, and so does
   * a window with no folder open at all.
   */
  for(resource?: vscode.Uri): AnoteConfig {
    const folder = resource
      ? vscode.workspace.getWorkspaceFolder(resource)
      : undefined
    const key = (folder ?? vscode.workspace.workspaceFolders?.[0])?.uri.toString()
    return (key && this.byFolder.get(key)) || DEFAULT_CONFIG
  }

  /** The folder a resource belongs to, or the first one — the root `notesDir`
   * and the MCP server's root are resolved against. */
  folderFor(resource?: vscode.Uri): vscode.WorkspaceFolder | undefined {
    return (
      (resource ? vscode.workspace.getWorkspaceFolder(resource) : undefined) ??
      vscode.workspace.workspaceFolders?.[0]
    )
  }

  /** Where new notes go in a folder — `notesDir` resolved against it. */
  notesRoot(folder: vscode.WorkspaceFolder): vscode.Uri {
    const dir = this.for(folder.uri).notesDir
    return dir === "." ? folder.uri : vscode.Uri.joinPath(folder.uri, dir)
  }

  /**
   * Reads every folder's config again.
   *
   * Awaited once at activation so nothing is drawn on the defaults and then
   * redrawn a tick later; after that it is the watcher's, and its result is the
   * event above.
   */
  async reload(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? []
    const read = await Promise.all(
      folders.map(async (folder) => {
        const config = await this.load(folder)
        return [folder.uri.toString(), config] as const
      })
    )

    this.byFolder.clear()
    for (const [key, config] of read) this.byFolder.set(key, config)
    this.changed.fire()
  }

  /**
   * One folder's config file.
   *
   * `workspace.fs` and not `node:fs`, for the reason everything else in
   * `src/host/` uses it: a folder on a remote or in a container is one VS Code
   * can read and Node cannot.
   *
   * A file that is not there is the ordinary case and says nothing. A file that
   * is there and does not parse is worth a word — somebody wrote it meaning
   * something, and silently ignoring it is how a setting appears not to work.
   */
  private async load(folder: vscode.WorkspaceFolder): Promise<AnoteConfig> {
    const uri = vscode.Uri.joinPath(folder.uri, CONFIG_FILE)

    let text: string
    try {
      text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString(
        "utf8"
      )
    } catch {
      return DEFAULT_CONFIG
    }

    let raw: unknown
    try {
      raw = text.trim() ? JSON.parse(text) : undefined
    } catch (error) {
      void vscode.window.showWarningMessage(
        `${CONFIG_FILE} in ${folder.name} does not parse as JSON — ANote is using its defaults. ` +
          (error instanceof Error ? error.message : "")
      )
      return DEFAULT_CONFIG
    }

    const { config, problems } = parseConfig(raw)
    if (problems.length > 0) {
      void vscode.window.showWarningMessage(
        `${CONFIG_FILE} in ${folder.name}: ${problems.join(" ")}`
      )
    }
    return config
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose()
    this.disposables.length = 0
    this.byFolder.clear()
  }
}
