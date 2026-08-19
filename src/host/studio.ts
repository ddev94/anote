import * as vscode from "vscode"

import type { NoteServer } from "./note-server"
import type { StudioWorkspace } from "./studio-routes"
import { assetFilenameFor } from "./note-files"
import { storeAsset } from "./assets"
import type { Configs } from "./config"
import { assetsDirFor, legacyAssetsDirFor } from "../config"

/**
 * The studio, as this editor's notes folder.
 *
 * `studio-routes.ts` is the studio; this is the half of it that knows about
 * VS Code. The split is the one `extension.ts`'s `sourceFor` already makes for the
 * pages and for the same two reasons: the routes can then be tested over a socket
 * with no editor running, and every read and write goes through `workspace.fs`, so
 * notes on a remote, in a container or in a virtual filesystem are notes the studio
 * can edit.
 *
 * **One folder at a time.** A studio is a sidebar of *the* notes folder, and a
 * multi-root window has several — so asking for one on a second folder moves it
 * there. It keeps the port and the link, because there is one server for everything
 * now (`note-server.ts`): what changes is which folder the sidebar shows. The
 * alternative was a folder as the first segment of every path, which is more URL,
 * more validation and more explaining for a case that is rare in the windows this
 * extension is actually used in. What is not acceptable is silently showing the
 * wrong folder's notes, and that is what this class exists to prevent.
 */
export class Studio {
  /** Which folder the mounted studio is on, so a request for another one is
   * recognised as a move rather than answered with the wrong notes. */
  private serving: string | null = null

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly configs: Configs,
    /** The one server. The studio does not own it — the pages are on it too. */
    private readonly notes: NoteServer
  ) {}

  /** Whether the workspace has turned the studio off — `studio.enabled`. Asked by
   * the command, so it can say so rather than opening a page nobody wanted. */
  enabledIn(folder: vscode.WorkspaceFolder): boolean {
    return this.configs.for(folder.uri).studio.enabled
  }

  /**
   * Mounts the studio on a folder, if that folder allows one.
   *
   * Called by both the studio commands and by *asking for a page's link*, which is
   * what makes the **Edit** button on a page work: the button is only rendered when
   * a studio is mounted for the note behind it. Mounting costs nothing — no second
   * port, no work until a request arrives — so the rule is simply that the studio
   * follows the folder you last asked about.
   *
   * Returns false for a workspace that has turned it off, so the caller can say so
   * rather than opening a page nobody wanted.
   */
  mount(folder: vscode.WorkspaceFolder): boolean {
    if (!this.enabledIn(folder)) return false

    const key = folder.uri.toString()
    if (this.serving === key) return true

    this.serving = key
    this.notes.mountStudio(this.workspaceFor(folder), () => {
      const config = this.configs.for(folder.uri)
      return {
        /* The preview's, not the studio's own: "how often does a note open in a
           browser ask whether it changed" is one question, and the studio is a note
           open in a browser. The *port* is the preview's too — there is one server
           and `preview.port` names it. */
        pollMs: config.preview.pollMs,
        theme: config.preview.theme,
        root: config.notesDir,
        assets: config.assets.dir,
        legacyAssets: config.assets.dirSuffix,
      }
    })
    return true
  }

  /** The studio's URL for a folder, mounting it and binding the port as needed, or
   * null for a folder that has turned it off. `note` is a path under that folder's
   * notes root — the note to open on, which is only ever a suggestion. */
  async open(
    folder: vscode.WorkspaceFolder,
    note?: string
  ): Promise<string | null> {
    if (!this.mount(folder)) return null
    return await this.notes.studioLink(note)
  }

  /** The path the studio addresses a note by — its path under the folder's notes
   * root. Empty for a note that is somewhere else entirely, which the studio
   * cannot show: its sidebar is that folder, and a page that opened on a note it
   * cannot list would be a page with no way back to itself. */
  pathFor(folder: vscode.WorkspaceFolder, note: vscode.Uri): string {
    const root = this.configs.notesRoot(folder).path.replace(/\/$/, "")
    if (note.path === root || !note.path.startsWith(`${root}/`)) return ""
    return note.path.slice(root.length + 1)
  }

  /**
   * How the server reads and writes this folder.
   *
   * Every path arriving here has been through the server's `notePathOf` — it is
   * relative to the notes root, POSIX, and holds no `..` — so these functions
   * join rather than validate. `vscode.Uri.joinPath` normalises what it is given,
   * which is a second line of defence and not the first one.
   */
  private workspaceFor(folder: vscode.WorkspaceFolder): StudioWorkspace {
    const root = () => this.configs.notesRoot(folder)
    const uriOf = (path: string) => vscode.Uri.joinPath(root(), path)
    const config = () => this.configs.for(folder.uri)

    /** The workspace's assets directory, as a URI. The same convention the editor
     * writes by — `assetsDirFor` is where that name is decided. */
    const assetsOf = () => vscode.Uri.joinPath(root(), assetsDirFor(config()))

    /** **Legacy.** The directory this note kept its own files in before there was
     * one for the folder. Never written to; still read, so a note written before
     * the change keeps its pictures. */
    const legacyAssetsOf = (note: string) => {
      const uri = uriOf(note)
      const name = uri.path.split("/").pop() ?? "note"
      return vscode.Uri.joinPath(
        uri.with({ path: uri.path.slice(0, uri.path.lastIndexOf("/")) }),
        legacyAssetsDirFor(name, config())
      )
    }

    /** Where a file the *editor* named is — a drawing's scene and the picture
     * exported from it. Wherever it already is, and the workspace's directory for
     * one nothing has written yet, which is `locateAsset`'s rule on the other
     * side of the same fork. */
    const assetUriOf = async (note: string, name: string) => {
      const legacy = vscode.Uri.joinPath(legacyAssetsOf(note), name)
      try {
        await vscode.workspace.fs.stat(legacy)
        return legacy
      } catch {
        return vscode.Uri.joinPath(assetsOf(), name)
      }
    }

    return {
      notes: async () => {
        /*
         * `findFiles` rather than a walk of our own, because it is the search
         * index: it already knows about the folder's excludes, it is answered
         * from the extension host on a remote without a round trip per
         * directory, and it is the same list `⌘P` shows. What it is told to skip
         * is the notes' own asset directories — a `.note` in there would be one
         * a note points at rather than one anybody wrote.
         */
        const found = await vscode.workspace.findFiles(
          new vscode.RelativePattern(root(), "**/*.note"),
          `{**/node_modules/**,**/${config().assets.dir}/**,` +
            `**/*${config().assets.dirSuffix}/**}`
        )
        const base = root().path.replace(/\/$/, "")
        return found
          .map((uri) =>
            uri.path.startsWith(`${base}/`) ? uri.path.slice(base.length + 1) : ""
          )
          .filter(Boolean)
      },

      /*
       * The open document's text first, and the file only if the note is not open.
       *
       * The same choice `sourceFor` makes for the preview, and here it is doing
       * more work than there: a note open in a VS Code tab with unsaved changes is
       * a note whose real text is in the editor, and a studio that showed the last
       * save would be one whose *next* save silently threw those changes away.
       * With this, the version the studio holds is the version it can see, which
       * is what makes the check in `saveNote` mean anything.
       */
      read: async (path) => {
        const uri = uriOf(path)
        const open = documentFor(uri)
        if (open) return open.getText()
        try {
          return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString(
            "utf8"
          )
        } catch {
          return null
        }
      },

      /**
       * Through the open document if there is one, and to the file if not.
       *
       * A `WorkspaceEdit` rather than `fs.writeFile` for an open note, because
       * VS Code owns that document: writing the file underneath it leaves an
       * editor holding text that is no longer what is on disk, and the next `⌘S`
       * in that tab would put it back. Saved straight afterwards, because the
       * person doing the typing is in a browser and has no `⌘S` here — a dirty dot
       * appearing in an editor they cannot see is not a state to leave them in.
       */
      write: async (path, text) => {
        const uri = uriOf(path)
        const open = documentFor(uri)
        if (!open) {
          await vscode.workspace.fs.writeFile(uri, Buffer.from(text, "utf8"))
          return
        }
        const edit = new vscode.WorkspaceEdit()
        edit.replace(
          uri,
          new vscode.Range(0, 0, open.lineCount, 0),
          text
        )
        await vscode.workspace.applyEdit(edit)
        await open.save()
      },

      create: async (path) => {
        const uri = uriOf(path)
        try {
          await vscode.workspace.fs.stat(uri)
          return false
        } catch {
          // Not there, which is the only case this goes on to write.
        }
        /* The directories on the way, which a note created inside a folder the
           sidebar only imagines — `notes/2026/Q3/Plan.note` — needs. `writeFile`
           makes parents itself, but only once the root exists. */
        await vscode.workspace.fs.createDirectory(
          uri.with({ path: uri.path.slice(0, uri.path.lastIndexOf("/")) })
        )
        // Empty, which is what `New Note` writes and what the editor treats as a
        // note nobody has typed into yet.
        await vscode.workspace.fs.writeFile(uri, new Uint8Array())
        return true
      },

      file: async (path) => {
        try {
          return await vscode.workspace.fs.readFile(uriOf(path))
        } catch {
          // A file that has gone — the page shows the block's "missing" line.
          return null
        }
      },

      /* `stat` and not a read: this is what a note's page asks before it puts a
         player around a clip, and reading a 200MB video to answer "is it there"
         would be the whole point missed. */
      exists: async (path) => {
        try {
          await vscode.workspace.fs.stat(uriOf(path))
          return true
        } catch {
          return false
        }
      },

      readAsset: async (note, name) => {
        try {
          return await vscode.workspace.fs.readFile(
            await assetUriOf(note, name)
          )
        } catch {
          // A drawing nobody has drawn in yet: the canvas opens empty.
          return null
        }
      },

      writeAsset: async (note, name, bytes) => {
        const target = await assetUriOf(note, name)
        await vscode.workspace.fs.createDirectory(
          target.with({ path: target.path.slice(0, target.path.lastIndexOf("/")) })
        )
        await vscode.workspace.fs.writeFile(target, bytes)
      },

      /* The file's own name, made safe, in the workspace's assets directory —
         the same naming `note-editor.ts` uses, so a file dropped into the studio
         is indistinguishable from one dropped into the editor. `storeAsset` is
         what decides a name that is already taken. */
      upload: async (note, name, mime, bytes) => {
        const stored = await storeAsset(
          assetsOf(),
          assetFilenameFor(name, mime),
          bytes
        )
        // Relative to the notes root and POSIX, which is what the document keeps.
        return `${assetsDirFor(config())}/${stored}`
      },

      bundle: async (name) => {
        try {
          return await vscode.workspace.fs.readFile(
            vscode.Uri.joinPath(this.context.extensionUri, "dist", name)
          )
        } catch {
          return null
        }
      },
    }
  }
}

/** The open document on this file, if there is one. */
function documentFor(uri: vscode.Uri): vscode.TextDocument | undefined {
  return vscode.workspace.textDocuments.find(
    (document) => document.uri.toString() === uri.toString()
  )
}
