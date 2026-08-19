import { randomUUID } from "node:crypto"
import * as vscode from "vscode"

import { assetsDirFor, type AnoteConfig } from "../config"
import type { NoteFormat, ToHost, ToWebview } from "../protocol"
import { assetsRootFor, locateAsset, storeAsset } from "./assets"
import type { Configs } from "./config"
import { assetFilenameFor, isAssetName } from "./note-files"
import {
  blocksTextOf,
  documentTextOf,
  formatOf,
  rewrites,
} from "./note-format"

/**
 * A `.note` file, edited as blocks.
 *
 * **`CustomTextEditorProvider` rather than `CustomEditorProvider`**, and that is
 * the decision the rest of this file follows from. The document stays a real
 * `TextDocument` that VS Code owns: it gets the dirty dot, `⌘S`, hot exit,
 * `File > Revert`, the diff against git, and a place in the editor's own undo
 * stack, none of which this extension has to implement. What it costs is the
 * echo problem below — an edit this view makes comes back to it as a change to
 * the document it just changed — and one guard is cheaper than owning a document
 * model.
 *
 * The webview is only a view. It holds no file, writes no file, and knows no
 * path: what it has is the text it was given and a URI it may load pictures
 * from.
 */
export class NoteEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = "anote.editor"
  /**
   * The same editor over a `.md`, as a *second* view type rather than a second
   * selector on the first.
   *
   * `priority` is a property of the contribution, not of the selector, and the
   * two files want opposite answers: a `.note` has no other editor and opens
   * here by default, while a `.md` has VS Code's own — and a markdown file that
   * suddenly opens as blocks in every repository somebody clones is this
   * extension taking something that was not offered. So `.md` is registered as
   * an option: `Reopen Editor With…`, the Explorer's **Open as Note**, or a line
   * in `workbench.editorAssociations` for whoever wants it always.
   */
  public static readonly markdownViewType = "anote.markdownEditor"

  /** The panels open on each document, so a command aimed at the active editor
   * can reach the webview that is drawing it. */
  private readonly panels = new Map<string, vscode.WebviewPanel>()

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly configs: Configs
  ) {}

  /** The webview drawing `uri`, if one is open. For the commands. */
  panelFor(uri: vscode.Uri): vscode.WebviewPanel | undefined {
    return this.panels.get(uri.toString())
  }

  /** The `anote.config.json` of the workspace folder this note is in. Read per
   * message rather than held, so a write to the file reaches an editor that was
   * already open. */
  private configFor(document: vscode.TextDocument): AnoteConfig {
    return this.configs.for(document.uri)
  }

  /** The documents already warned about, so a note that is reopened, or looked
   * at twice, is not a second dialog. Per session, which is as long as the
   * decision is interesting. */
  private readonly warned = new Set<string>()

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
    token: vscode.CancellationToken
  ): Promise<void> {
    const format = formatOf(document.uri.path)
    const dir = document.uri.with({
      path: document.uri.path.slice(0, document.uri.path.lastIndexOf("/")),
    })

    const assets = assetsRootFor(document.uri, this.configs)

    panel.webview.options = {
      enableScripts: true,
      /*
       * Three roots and no more: this extension's own bundle, the shared assets
       * directory a picture dropped into a note goes in, and the directory the
       * note is in — which is what a picture in an older note is relative to. A
       * webview may load nothing else off the disk, so a note that names
       * `../../.ssh/id_rsa` gets a blocked request rather than a picture.
       *
       * The pool itself rather than the notes root above it, which is the whole
       * point of the name being on the front of the stored path: the root defaults
       * to the workspace folder, and a root here would be this extension handing a
       * webview the repository.
       */
      localResourceRoots: [this.context.extensionUri, dir, assets],
    }
    panel.webview.html = this.html(panel.webview)
    this.panels.set(document.uri.toString(), panel)

    /*
     * The echo guard.
     *
     * An edit from the webview is applied to the document, which fires
     * `onDidChangeTextDocument`, which would send the text straight back — and
     * since the webview rebuilds its editor for text it did not write, the caret
     * would jump to the top of the note on every keystroke. So the text this
     * side wrote is remembered, and a change that matches it is the echo of an
     * edit the webview already has.
     *
     * The text rather than a boolean, because edits are debounced and a boolean
     * would be cleared by the wrong change.
     */
    let mine: string | undefined

    const changes = vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.uri.toString() !== document.uri.toString()) return
      const text = event.document.getText()
      if (text === mine) return
      void post(panel, { type: "external", text: blocksTextOf(text, format) })
    })

    const themes = vscode.window.onDidChangeActiveColorTheme((theme) => {
      void post(panel, { type: "theme", theme: themeOf(theme) })
    })

    const messages = panel.webview.onDidReceiveMessage(
      async (message: ToHost) => {
        switch (message.type) {
          case "ready":
            // Not at the top of this function: a message posted before the
            // webview's own script has run is a message nobody hears, so the
            // first move is the webview's.
            this.warnIfRewritten(document, format)
            return void post(panel, {
              type: "init",
              text: blocksTextOf(document.getText(), format),
              dirUri: panel.webview.asWebviewUri(dir).toString(),
              assetsUri: panel.webview.asWebviewUri(assets).toString(),
              assetsDir: assetsDirFor(this.configFor(document)),
              theme: themeOf(vscode.window.activeColorTheme),
              format,
            })

          case "edit": {
            /* The blocks, as the file they came out of. A `.md` is written back
               as markdown, and a document that cannot be turned into one is not
               written at all — an unreadable message is a bug on this side, and
               the one thing worse than dropping it is overwriting somebody's
               file with the fallout. */
            const written = documentTextOf(message.text, format)
            if (written === null) {
              return void vscode.window.showErrorMessage(
                "That edit could not be written back — the note has been left as it was."
              )
            }
            if (written === document.getText()) return
            mine = written
            const edit = new vscode.WorkspaceEdit()
            edit.replace(
              document.uri,
              new vscode.Range(0, 0, document.lineCount, 0),
              written
            )
            await vscode.workspace.applyEdit(edit)
            return
          }

          case "uploadFile":
            return void (await this.upload(panel, document, message))

          case "writeAsset": {
            const target = await this.assetUri(document, message.name)
            if (!target) {
              return void post(panel, {
                type: "assetWritten",
                id: message.id,
                failed: `Not a name beside this note: ${message.name}`,
              })
            }
            try {
              /* The directory first: a drawing may well be the first thing
                 anything writes into a workspace's assets directory, and
                 `writeFile` only makes parents once the one above them is
                 there. */
              await vscode.workspace.fs.createDirectory(
                target.with({
                  path: target.path.slice(0, target.path.lastIndexOf("/")),
                })
              )
              await vscode.workspace.fs.writeFile(
                target,
                Buffer.from(message.base64, "base64")
              )
              return void post(panel, { type: "assetWritten", id: message.id })
            } catch (error) {
              return void post(panel, {
                type: "assetWritten",
                id: message.id,
                failed:
                  error instanceof Error
                    ? error.message
                    : "Could not write it.",
              })
            }
          }

          case "readAsset": {
            const source = await this.assetUri(document, message.name)
            let base64: string | null = null
            try {
              if (source) {
                base64 = Buffer.from(
                  await vscode.workspace.fs.readFile(source)
                ).toString("base64")
              }
            } catch {
              // Not there, which for a drawing means one nobody has drawn in
              // yet — the canvas opens empty rather than failing.
            }
            return void post(panel, {
              type: "assetRead",
              id: message.id,
              base64,
            })
          }

          case "failed":
            return void vscode.window.showErrorMessage(message.message)
        }
      }
    )

    panel.onDidDispose(() => {
      changes.dispose()
      themes.dispose()
      messages.dispose()
      this.panels.delete(document.uri.toString())
    })

    if (token.isCancellationRequested) panel.dispose()
  }

  /**
   * Says so, once, when opening this `.md` as blocks would not give the same
   * file back.
   *
   * `markdownToBlocks` is a subset by design — reference links, raw HTML blocks,
   * setext headings and loose definition lists are read as the paragraphs they
   * look like — and this editor writes the whole file on the first keystroke. So
   * a README opened here and typed one character into comes back in this
   * extension's own dialect, and the diff is the whole document. That is a
   * perfectly reasonable thing to want and a terrible thing to find out
   * afterwards.
   *
   * The check itself is `rewrites` in `note-format.ts` — the round trip run
   * against the file, rather than a list of syntax to look for.
   */
  private warnIfRewritten(
    document: vscode.TextDocument,
    format: NoteFormat
  ): void {
    if (format !== "markdown") return
    const key = document.uri.toString()
    if (this.warned.has(key)) return

    if (!rewrites(document.getText())) return

    this.warned.add(key)
    void vscode.window.showWarningMessage(
      `${document.uri.path.split("/").pop()} is markdown this editor rewrites: ` +
        "saving it here replaces the file with the blocks' own markdown, so " +
        "anything it read as a plain paragraph — reference links, raw HTML, " +
        "setext headings — comes back as one. Close without saving to leave it as it is."
    )
  }

  /**
   * Writes a dropped file into the workspace's assets directory and hands back
   * the path the document will hold.
   *
   * One directory at the notes root, shared by every note in the folder, and
   * named `assets.dir` in `anote.config.json`. Why that rather than a directory
   * per note — and how the per-note ones this extension used to write go on being
   * read — is the header of `host/assets.ts`.
   *
   * **The file keeps its own name.** The extension comes from the browser's idea
   * of the type, because that is what the bytes actually are, and the stem is the
   * name the file arrived with, with anything a path or a URL would argue about
   * taken out of it (`assetFilenameFor`). A name that is already taken is
   * answered by `storeAsset`: the same bytes reuse the file, different bytes get
   * `-1`, and nothing is ever overwritten.
   */
  private async upload(
    panel: vscode.WebviewPanel,
    document: vscode.TextDocument,
    message: Extract<ToHost, { type: "uploadFile" }>
  ): Promise<void> {
    try {
      const dir = assetsDirFor(this.configFor(document))
      const stored = await storeAsset(
        assetsRootFor(document.uri, this.configs),
        assetFilenameFor(message.name, message.mime),
        Buffer.from(message.base64, "base64")
      )
      await post(panel, {
        type: "uploaded",
        id: message.id,
        // Relative to the notes root and POSIX, which is what the document keeps.
        path: `${dir}/${stored}`,
      })
    } catch (error) {
      await post(panel, {
        type: "uploadFailed",
        id: message.id,
        message:
          error instanceof Error
            ? error.message
            : "Could not save that file with the note's.",
      })
    }
  }

  /**
   * Where a name the webview chose lands, or null if it is not a name.
   *
   * The check itself is `isAssetName` in `note-files.ts` — the studio's server
   * holds the same door for the same two calls arriving over a socket, and a rule
   * like this is only worth anything while both spellings of it agree. Where the
   * file goes is `locateAsset`: wherever it already is, and the shared directory
   * for one nothing has written yet.
   */
  private async assetUri(
    document: vscode.TextDocument,
    name: string
  ): Promise<vscode.Uri | null> {
    if (!isAssetName(name)) return null
    return await locateAsset(document.uri, this.configs, name)
  }

  /**
   * The page the webview runs.
   *
   * A nonce and a `Content-Security-Policy` because that is the contract for a
   * webview: `enableScripts` without one is a page that could load anything from
   * anywhere. `img-src` allows the webview's own scheme (the pictures, resolved
   * through `asWebviewUri`), `data:` (an image pasted out of a browser arrives
   * as one) and `https:` (an image embedded from the web) — and nothing else.
   *
   * **`media-src` is on the list, and it is the reason `<video>` and `<audio>`
   * blocks work.** `default-src 'none'` covers every fetch a directive does not
   * name, so with `img-src` alone a picture loaded and a clip did not — silently,
   * because a blocked media element is an element that simply never plays. `blob:`
   * for the same reason it is on the picture list: that is what a clip pasted out
   * of another page arrives as.
   */
  private html(webview: vscode.Webview): string {
    const nonce = randomUUID().replace(/-/g, "")
    const asset = (name: string) =>
      webview.asWebviewUri(
        vscode.Uri.joinPath(this.context.extensionUri, "dist", name)
      )

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data: https:; media-src ${webview.cspSource} data: blob: https:; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource} data:; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${asset("webview.css")}">
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}">window.EXCALIDRAW_ASSET_PATH = "${asset("excalidraw/")}/";</script>
<script nonce="${nonce}" src="${asset("webview.js")}"></script>
</body>
</html>`
  }
}

function themeOf(theme: vscode.ColorTheme): "dark" | "light" {
  return theme.kind === vscode.ColorThemeKind.Dark ||
    theme.kind === vscode.ColorThemeKind.HighContrast
    ? "dark"
    : "light"
}

/** Typed, so a message added to the protocol cannot be posted from here without
 * the webview having a case for it. */
function post(
  panel: vscode.WebviewPanel,
  message: ToWebview
): Thenable<boolean> {
  return panel.webview.postMessage(message)
}
