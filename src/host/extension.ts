import { randomBytes } from "node:crypto"

import * as vscode from "vscode"

import { Configs } from "./config"
import { provideMcpServer } from "./mcp-provider"
import { parseNote } from "./note-blocks"
import { NoteEditorProvider } from "./note-editor"
import { blocksToMarkdown } from "./note-markdown"
import { NoteServer } from "./note-server"
import { NotePreviews } from "./preview"
import type { NoteSource } from "./preview-pages"
import { Studio } from "./studio"
import { assetsDirFor, CONFIG_FILE, DEFAULT_CONFIG } from "../config"

/**
 * What both registrations of the editor are given.
 *
 * `retainContextWhenHidden` is the trade this extension cannot avoid.
 *
 * Off, a webview is torn down whenever its tab stops being visible and rebuilt
 * from the document when it comes back — which for a block editor means the
 * caret, the scroll position and the whole undo history go with it every time
 * somebody looks at another file. On, every open note keeps a live webview in
 * memory.
 *
 * The app solves this properly by mounting one editor per open tab and only
 * hiding the ones off screen; a webview has no equivalent, so this is the closer
 * of the two behaviours to it. It is also why this extension does not want
 * thirty notes open.
 *
 * `enableFindWidget` is Ctrl/Cmd+F. A webview gets no find widget unless it asks
 * for one: without this the keystroke falls through to the workbench, which has
 * no text editor to search and so does nothing at all. On, VS Code draws its own
 * find bar over the note and searches the rendered page.
 */
const EDITOR_OPTIONS = {
  webviewOptions: {
    retainContextWhenHidden: true,
    enableFindWidget: true,
  },
  supportsMultipleEditorsPerDocument: false,
} as const

/**
 * ANote — a notes panel, as a VS Code extension.
 *
 * What is *not* here is the point. The desktop app this comes from draws its own
 * sidebar tree for notes — nesting, drag to reparent, rename in the row, a delete
 * that counts what it takes, a tab strip, and a store that debounces a write per
 * note 400ms after the typing stops. None of that is in this extension, because a
 * note here is **a file in the workspace**: the Explorer is the tree, the tabs are
 * VS Code's, rename and move and delete are the Explorer's, `⌘P` and workspace
 * search already find it, and the dirty dot and `⌘S` are the editor's.
 *
 * So what is left is the part that was actually the panel: the editor, the
 * pictures beside the note, and the preview.
 *
 * **Except in the browser, where none of that is true.** `Open Studio` serves the
 * notes folder as a page — the same block editor, with the tree the app had, on a
 * loopback URL — because outside VS Code there is no Explorer to be the tree, no
 * tab strip and no `⌘S`. Everything this file leaves to the editor, `studio.ts` and
 * `studio-routes.ts` have to answer for themselves; that they are the only files
 * that do is what keeps this one small.
 */
export async function activate(
  context: vscode.ExtensionContext
): Promise<void> {
  /* `anote.config.json`, per workspace folder — see `config.ts` here and
     `src/config.ts` for the shape. Awaited rather than let load in the
     background: everything below reads it, and an editor drawn on the defaults
     and corrected a tick later is worse than one that opens right. A workspace
     with no config file is the ordinary case and this costs it one stat. */
  const configs = new Configs()
  await configs.reload()

  const editors = new NoteEditorProvider(context, configs)
  const previews = new NotePreviews(context, configs)
  /* One port for everything a browser can reach: a note as a page, and the studio
     that edits it. Bound on the first link asked for, so a workspace whose notes
     are never opened outside the editor never opens a port at all. On the
     subscriptions, so it goes down with the window rather than outliving it. See
     the header of `note-server.ts` for what the two surfaces sharing an origin
     bought and cost. */
  const notes = new NoteServer(() => configs.for().preview)
  /* The writable half of that server, mounted on one workspace folder at a time —
     by the studio commands, and by any request for a page's link, which is what
     puts the **Edit** button on the page. */
  const studio = new Studio(context, configs, notes)

  context.subscriptions.push(
    configs,
    notes,
    /* The notes, offered to the editor's own agent — one server per workspace
       folder, configured by the extension rather than by whoever installed it.
       See `mcp-provider.ts`. */
    provideMcpServer(context, configs),
    /* One provider, two view types: a `.note` opens here by default and a `.md`
       is an option — which is a property of the contribution rather than of the
       selector, so it takes two. See `markdownViewType` in `note-editor.ts`. */
    vscode.window.registerCustomEditorProvider(
      NoteEditorProvider.viewType,
      editors,
      EDITOR_OPTIONS
    ),
    vscode.window.registerCustomEditorProvider(
      NoteEditorProvider.markdownViewType,
      editors,
      EDITOR_OPTIONS
    ),

    vscode.commands.registerCommand("anote.new", (folder?: vscode.Uri) =>
      newNote(configs, folder)
    ),

    /* The way into the block editor for a markdown file, which VS Code otherwise
       only offers through `Reopen Editor With…`. The Explorer passes the file
       that was right-clicked; from the palette it is whatever is open. */
    vscode.commands.registerCommand("anote.openAsNote", (file?: vscode.Uri) =>
      openAsNote(file)
    ),

    vscode.commands.registerCommand("anote.openConfig", () =>
      openConfig(configs)
    ),

    vscode.commands.registerCommand("anote.openPreview", () => {
      const document = activeNote()
      if (document) previews.show(document)
      else void vscode.window.showInformationMessage(NO_NOTE)
    }),

    /* Light, dark, or the editor's own — see `NotePreviews.cycleTheme`. It says
       which one it landed on, because a preview of a note with no colour in it
       can look much the same in two of the three, and a toggle that gives no
       sign it fired is one people press twice. */
    vscode.commands.registerCommand("anote.togglePreviewTheme", () =>
      togglePreviewTheme(previews)
    ),

    vscode.commands.registerCommand("anote.copyPreviewLink", () =>
      link(notes, studio, configs, "copy")
    ),

    vscode.commands.registerCommand("anote.openInBrowser", () =>
      link(notes, studio, configs, "open")
    ),

    vscode.commands.registerCommand("anote.openStudio", () =>
      openStudio(studio, configs, "open")
    ),

    vscode.commands.registerCommand("anote.copyStudioLink", () =>
      openStudio(studio, configs, "copy")
    ),

    vscode.commands.registerCommand("anote.exportMarkdown", () =>
      exportMarkdown(configs)
    )
  )
}

export function deactivate(): void {
  // Nothing: every disposable is on the context, and the webviews go with their
  // tabs.
}

/**
 * What the two commands say when they were run with no note in front of them.
 *
 * They say it rather than doing nothing, and neither is hidden from the palette
 * behind a `when` clause any more. A command that is invisible and a command that
 * is silent fail the same way from the outside — you cannot tell whether the
 * feature is missing, broken, or just not for the tab you are on. The context key
 * that used to gate both of these was `activeCustomEditorId`, and when it did not
 * match, the preview was nowhere to be found at all.
 */
const NO_NOTE = "Open a .note file first — this is the preview of one."

/**
 * The note the active custom editor is on.
 *
 * `visibleTextEditors` is no use here — a custom editor is not a text editor, so
 * a note being edited appears in none of them. The tab does know its input, and
 * for a custom editor that input carries the URI.
 */
function activeNote(): vscode.TextDocument | undefined {
  const uri = activeNoteUri()
  if (!uri) return undefined

  return vscode.workspace.textDocuments.find(
    (document) => document.uri.toString() === uri.toString()
  )
}

/**
 * The file the active tab is on, if it is a note.
 *
 * The URI alone, for the link commands: those need a file, not an open document —
 * the server reads whichever of the two is more current.
 */
function activeNoteUri(): vscode.Uri | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input
  const uri =
    input instanceof vscode.TabInputCustom
      ? input.uri
      : input instanceof vscode.TabInputText
        ? input.uri
        : undefined
  return uri?.path.endsWith(".note") ? uri : undefined
}

/**
 * Opens a markdown file in the block editor.
 *
 * `.md` only, and that is the whole check: a `.note` already opens here, and
 * asking this of a `.png` is a webview that would have nothing to draw. The
 * markdown view type rather than the note one, because that is what tells the
 * editor which of the two files it is looking at.
 */
async function openAsNote(file?: vscode.Uri): Promise<void> {
  const uri = file ?? activeFileUri()
  if (!uri || !uri.path.toLowerCase().endsWith(".md")) {
    void vscode.window.showInformationMessage(
      "Open a .md file first — this opens one as blocks."
    )
    return
  }

  await vscode.commands.executeCommand(
    "vscode.openWith",
    uri,
    NoteEditorProvider.markdownViewType
  )
}

/** Whatever file the active tab is showing, whichever kind of editor is showing
 * it. `activeNoteUri` above is this with `.note` insisted on. */
function activeFileUri(): vscode.Uri | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input
  if (input instanceof vscode.TabInputCustom) return input.uri
  if (input instanceof vscode.TabInputText) return input.uri
  return undefined
}

/**
 * A new, empty note, and opens it.
 *
 * `showInputBox` for the name and not an inline field, unlike the rename in the
 * app's own tree: there is no row to type in yet, and this is the flow VS Code's
 * own "New File…" uses. The Explorer's context menu passes the folder that was
 * right-clicked and that always wins — somebody who right-clicked a folder has
 * said where they want it. From the palette there is no such answer, and
 * `notesDir` in `anote.config.json` is the workspace's: `.` for the folder
 * itself, which is the default and what a workspace that has never been
 * configured does.
 */
async function newNote(configs: Configs, folder?: vscode.Uri): Promise<void> {
  const workspace = configs.folderFor(folder)
  const root = folder ?? (workspace && configs.notesRoot(workspace))
  if (!root) {
    void vscode.window.showErrorMessage("Open a folder to keep notes in first.")
    return
  }

  const name = await vscode.window.showInputBox({
    title: "New note",
    prompt: "The file is created in the folder you are in.",
    value: configs.for(root).newNote.defaultName,
    validateInput: (value) =>
      value.trim() && !/[/\\]/.test(value)
        ? undefined
        : "A name, with no path separators in it.",
  })
  if (name === undefined) return

  const target = vscode.Uri.joinPath(root, `${name.trim()}.note`)
  try {
    /* `notesDir` may name a folder nobody has made yet, and `writeFile` will
       make the parents — but only once it has somewhere to put them, which on a
       fresh clone it does not. One `createDirectory` is cheaper than the error
       message explaining why the first note in a configured workspace failed. */
    await vscode.workspace.fs.createDirectory(root)
    // An empty document rather than an empty array, because that is what the
    // editor treats as "a note nobody has typed into" — see the webview's
    // `initialContent`.
    await vscode.workspace.fs.writeFile(target, new Uint8Array())
    await vscode.commands.executeCommand("vscode.open", target)
  } catch (error) {
    void vscode.window.showErrorMessage(
      error instanceof Error ? error.message : "Could not create that note."
    )
  }
}

/**
 * The preview's palette, moved on one.
 *
 * It applies to every preview that is open and to every one opened afterwards,
 * including in the next window — so it is worth saying which of the three it is
 * now on. The status bar rather than a notification: this is a view setting
 * somebody is likely to press twice in a row, and three modal toasts for that
 * would be worse than the thing they were toasting.
 */
async function togglePreviewTheme(previews: NotePreviews): Promise<void> {
  const theme = await previews.cycleTheme()
  const said = theme === "auto" ? "the editor's theme" : `always ${theme}`
  void vscode.window.setStatusBarMessage(`Note preview: ${said}`, 3000)
}

/**
 * The note's link — on the clipboard, or in the browser.
 *
 * Both from one function because they are one act with two endings, and because
 * the interesting half is shared: asking for a link is what binds the server and
 * registers the note, so the first thing either command does is the same thing.
 *
 * The note is taken from the active tab rather than needing to be open in an
 * editor of ours — a `.note` selected in the Explorer is a note somebody wants a
 * link to just as much.
 */
async function link(
  server: NoteServer,
  studio: Studio,
  configs: Configs,
  then: "copy" | "open"
): Promise<void> {
  const uri = activeNoteUri()
  if (!uri) {
    void vscode.window.showInformationMessage(NO_NOTE)
    return
  }

  try {
    /*
     * The studio, mounted on this note's folder — which is what puts the **Edit**
     * button on the page it is about to hand over.
     *
     * A side effect of asking for a link, and a deliberate one: there is one port
     * and mounting costs nothing until a request arrives, so the alternative would
     * have been a page whose Edit button works or not depending on whether somebody
     * had run a different command first. A workspace with `studio.enabled` false
     * mounts nothing, and the page then has no button — which is the honest
     * rendering of "this workspace does not have one".
     */
    const folder = configs.folderFor(uri)
    const studioPath = folder && studio.mount(folder)
      ? studio.pathFor(folder, uri) || undefined
      : undefined

    const loopback = await server.linkTo(pathFor(uri), {
      ...sourceFor(uri, configs),
      studioPath,
    })
    /*
     * The URL the *user's* browser can reach, which on a local window is the
     * loopback one unchanged.
     *
     * With VS Code attached to a remote — SSH, WSL, a container, a Codespace —
     * this extension is running there, and `127.0.0.1:<port>` on that machine is
     * not somewhere the browser here can go. This is the call that sets up the
     * forwarding, and it is the one line that makes the feature work in a place
     * the desktop app cannot run at all.
     */
    const url = await vscode.env.asExternalUri(vscode.Uri.parse(loopback))

    if (then === "open") {
      await vscode.env.openExternal(url)
      return
    }
    await vscode.env.clipboard.writeText(url.toString())
    void vscode.window.setStatusBarMessage(
      "Preview link copied — it lasts as long as this window",
      4000
    )
  } catch (error) {
    void vscode.window.showErrorMessage(
      error instanceof Error ? error.message : "Could not start the preview."
    )
  }
}

/**
 * The path a note is addressed at in a preview link — `auth/login.note`.
 *
 * Its path in the workspace, which is what makes a link readable and what makes
 * two links to two notes different. `asRelativePath` is the one that knows: with
 * several folders open it puts the folder's name in front, so two notes at the same
 * path in two folders are still two paths.
 *
 * **A note outside every workspace folder falls back to a made-up id.** There the
 * relative path is an absolute one — the reader's home directory, a drive letter,
 * every folder on the way — and putting that in a URL would say more about the
 * machine than the old opaque link ever did. It is also the case that has no
 * uniqueness to offer: two files called `Notes.note` in two unrelated directories
 * would collide, and a link that quietly points at the wrong note is worse than an
 * unreadable one. Keyed by the whole URI so the same note asks twice and gets the
 * same link, which is what the server's map wants.
 */
const outsiders = new Map<string, string>()

function pathFor(uri: vscode.Uri): string {
  const relative = vscode.workspace.asRelativePath(uri, true)
  // `asRelativePath` hands back the path it was given when nothing contains it.
  const outside =
    relative === uri.fsPath || relative === uri.path || relative.startsWith("/")
  if (!outside) return relative

  const key = uri.toString()
  const made = outsiders.get(key) ?? randomBytes(9).toString("hex")
  outsiders.set(key, made)
  return `${made}/${uri.path.slice(uri.path.lastIndexOf("/") + 1)}`
}

/**
 * How the server reads one note: the text, and the pictures beside it.
 *
 * The editor's own text first, and the file only if the note is not open — the
 * point of a link beside the editor is watching it keep up, and a preview showing
 * the last save while the note has moved on is showing the wrong thing.
 *
 * `workspace.fs` and not `node:fs`, throughout: a note on a remote, in a
 * container, or in a virtual filesystem is one VS Code can read and Node cannot,
 * and this is the whole of what the server would have had to know about that.
 */
function sourceFor(uri: vscode.Uri, configs: Configs): NoteSource {
  const dir = uri.with({ path: uri.path.slice(0, uri.path.lastIndexOf("/")) })

  return {
    name:
      uri.path
        .split("/")
        .pop()
        ?.replace(/\.note$/, "") ?? "Note",

    text: async () => {
      const open = vscode.workspace.textDocuments.find(
        (document) => document.uri.toString() === uri.toString()
      )
      if (open) return open.getText()
      return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString(
        "utf8"
      )
    },

    file: async (relative) => {
      try {
        return await vscode.workspace.fs.readFile(
          vscode.Uri.joinPath(dir, relative)
        )
      } catch {
        // A file that has gone — the page says what it was.
        return null
      }
    },

    has: async (relative) => {
      try {
        await vscode.workspace.fs.stat(vscode.Uri.joinPath(dir, relative))
        return true
      } catch {
        return false
      }
    },

    drawingSvg: async (id) => {
      // What the editor exports beside the scene every time a drawing is saved.
      // The name is built from an id the document holds, so it is built the same
      // way `assetUri` builds one — and checked the same way.
      if (!/^[0-9a-z-]{1,64}$/i.test(id)) return ""
      try {
        const bytes = await vscode.workspace.fs.readFile(
          vscode.Uri.joinPath(dir, `${assetsName(uri, configs)}/${id}.svg`)
        )
        return Buffer.from(bytes).toString("utf8")
      } catch {
        // Never saved, so never exported. The page says so.
        return ""
      }
    },
  }
}

/** The directory a note's files live in — `<note name>.assets`, beside it,
 * unless the workspace's `assets.dirSuffix` says otherwise. */
function assetsName(note: vscode.Uri, configs: Configs): string {
  return assetsDirFor(note.path.split("/").pop() ?? "note", configs.for(note))
}

/**
 * The studio, in the browser or on the clipboard.
 *
 * The same two endings the preview link has, and the same reason for sharing a
 * function: asking for the URL is what binds the server, so the first half of both
 * commands is one act.
 *
 * What is different is what has to be decided first. The studio is a sidebar of one
 * folder's notes (see `Studio`), so a multi-root window has to be asked which —
 * and the note in front of you is the best answer there is, because somebody who
 * ran this from a note wants that note. Failing that, one folder is its own answer
 * and several is a question.
 */
async function openStudio(
  studio: Studio,
  configs: Configs,
  then: "open" | "copy"
): Promise<void> {
  const note = activeNoteUri()
  const folder = await folderForStudio(configs, note)
  if (!folder) return

  try {
    const loopback = await studio.open(
      folder,
      /* Only a note inside this folder's notes root, because the studio's sidebar
         is that root: opening on a note it cannot list would be a page with no way
         back to itself. `pathFor` answers "" for anything else and the studio then
         opens on no note at all. */
      note ? studio.pathFor(folder, note) || undefined : undefined
    )
    if (!loopback) {
      void vscode.window.showInformationMessage(
        `${folder.name} has turned the studio off — studio.enabled in ${CONFIG_FILE}.`
      )
      return
    }
    /* The URL the *user's* browser can reach — the same forwarding the preview
       link needs, and the line that makes this work with VS Code attached to a
       remote, a container or a Codespace. */
    const url = await vscode.env.asExternalUri(vscode.Uri.parse(loopback))

    if (then === "open") {
      await vscode.env.openExternal(url)
      return
    }
    await vscode.env.clipboard.writeText(url.toString())
    void vscode.window.setStatusBarMessage(
      "Studio link copied — it lasts as long as this window",
      4000
    )
  } catch (error) {
    void vscode.window.showErrorMessage(
      error instanceof Error ? error.message : "Could not start the studio."
    )
  }
}

/**
 * Which folder's notes the studio opens on.
 *
 * The note in front of you decides it when there is one. Otherwise: no folder is an
 * error, one folder is the answer, and several is a question — asked rather than
 * guessed, because the studio takes a port and a wrong guess is a tab full of
 * somebody else's repository.
 */
async function folderForStudio(
  configs: Configs,
  note?: vscode.Uri
): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? []
  if (folders.length === 0) {
    void vscode.window.showErrorMessage(
      "Open a folder of notes first — the studio is a folder, not a file."
    )
    return undefined
  }
  if (note) return configs.folderFor(note)
  if (folders.length === 1) return folders[0]

  const picked = await vscode.window.showQuickPick(
    folders.map((folder) => ({ label: folder.name, folder })),
    { title: "Open the studio on which folder?" }
  )
  return picked?.folder
}

/**
 * `anote.config.json`, open — written first if it is not there.
 *
 * A command rather than a line in the README, because a config file nobody can
 * find is a config file nobody uses. What it writes is the defaults, in full and
 * with the `$schema` line on it: an empty `{}` would be less to read but also
 * less to *edit*, and the schema is registered against this filename (see
 * `contributes.jsonValidation`) so every key below completes and describes
 * itself in the editor.
 *
 * Nothing is written when the file already exists — this is the command people
 * will reach for to *change* a setting, and overwriting somebody's config with
 * the defaults because they pressed the wrong thing is not recoverable from the
 * Explorer.
 */
async function openConfig(configs: Configs): Promise<void> {
  const folder = configs.folderFor()
  if (!folder) {
    void vscode.window.showErrorMessage("Open a folder to configure ANote in.")
    return
  }

  const uri = vscode.Uri.joinPath(folder.uri, CONFIG_FILE)
  try {
    try {
      await vscode.workspace.fs.stat(uri)
    } catch {
      await vscode.workspace.fs.writeFile(
        uri,
        Buffer.from(
          `${JSON.stringify({ $schema: SCHEMA_URL, ...DEFAULT_CONFIG }, null, 2)}\n`,
          "utf8"
        )
      )
    }
    await vscode.window.showTextDocument(uri, { preview: false })
  } catch (error) {
    void vscode.window.showErrorMessage(
      error instanceof Error ? error.message : `Could not open ${CONFIG_FILE}.`
    )
  }
}

/** What a written config points `$schema` at. The extension also registers the
 * schema against this filename, so the line is a courtesy to editors that read
 * one and not the other. */
const SCHEMA_URL = "https://anote.dev/schemas/anote.config.json"

/**
 * The note as markdown, beside it.
 *
 * **It used to ask the webview**, because BlockNote's serialiser is a method on a
 * live editor — so the command needed the note open, in a mounted editor, and it
 * quietly did not work: `blocksToMarkdownLossy` returns a promise, and a promise
 * posted across a webview message arrives as `{}`. `note-markdown.ts` is that
 * serialiser written as a walk over the blocks instead, the way `note-html.ts`
 * already was, and the export is now what the preview commands are: a file on
 * disk in, a file on disk out, with nothing needing to be on screen.
 */
async function exportMarkdown(configs: Configs): Promise<void> {
  const uri = activeNoteUri()
  if (!uri) {
    void vscode.window.showInformationMessage(NO_NOTE)
    return
  }

  try {
    const blocks = parseNote(await sourceFor(uri, configs).text())
    const target = uri.with({ path: `${uri.path.replace(/\.note$/, "")}.md` })
    await vscode.workspace.fs.writeFile(
      target,
      Buffer.from(blocksToMarkdown(blocks), "utf8")
    )
    await vscode.window.showTextDocument(target, { preview: false })
  } catch (error) {
    void vscode.window.showErrorMessage(
      error instanceof Error ? error.message : "Could not export that note."
    )
  }
}
