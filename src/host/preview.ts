import { createHash } from "node:crypto"
import * as vscode from "vscode"

import type { Configs } from "./config"
import { drawingIdsIn, parseNote, withResolvedUrls } from "./note-blocks"
import { page, renderNote, type PreviewTheme } from "./note-html"
import { assetsDirFor } from "../config"
import type { NoteBlock } from "../protocol"

/**
 * The note as a finished page, beside the note.
 *
 * Server-rendered, in the extension host, for the reason the app's own preview
 * is: a page that arrives complete needs no editor to have been open and no
 * script to run before the words are there. Here it also means the preview keeps
 * working when the note's own tab is not the one on screen.
 *
 * One panel per document, reused. Two previews of one note is two things to keep
 * in step and nobody asked for the second.
 */
export class NotePreviews {
  private readonly panels = new Map<string, vscode.WebviewPanel>()

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly configs: Configs
  ) {
    // The preview follows the note as it is typed into. `onDidChangeTextDocument`
    // rather than a save, because the point of having it open beside the editor
    // is watching it keep up.
    context.subscriptions.push(
      vscode.workspace.onDidChangeTextDocument((event) => {
        const panel = this.panels.get(event.document.uri.toString())
        if (panel) this.draw(panel, event.document)
      }),
      // `anote.config.json` names the palette a preview starts on, so a write to
      // it is a redraw of every preview that has not been told otherwise.
      this.configs.onDidChange(() => this.redraw())
    )
  }

  /**
   * The palette the previews are drawn in.
   *
   * Two places, in this order: what the toggle command last landed on, and then
   * `preview.theme` from the workspace's `anote.config.json`. The toggle wins
   * because it is the more recent and more specific act — a person pressing a
   * button in this window — while the config file is what a *repository* says
   * its notes read best in, which is exactly the right thing to be overridden.
   *
   * The toggle's answer is in `globalState`, so it is remembered across windows:
   * that is a decision about reading rather than about a note, and somebody who
   * reads previews dark wants the next one dark too. Three states rather than
   * two, because "follow VS Code" is a real answer and the one most people want
   * — a toggle that only knew light and dark would have no way back to it.
   */
  themeFor(note?: vscode.Uri): PreviewTheme {
    const stored = this.context.globalState.get<string>(THEME_KEY)
    if (stored === "light" || stored === "dark" || stored === "auto") {
      return stored
    }
    return this.configs.for(note).preview.theme
  }

  /**
   * The next palette along, applied to every preview that is open.
   *
   * Re-rendered rather than switched in the page: these webviews run no script —
   * `enableScripts` is off, and the whole reason the preview is server-rendered
   * is that it needs none — so redrawing the HTML *is* the switch. It costs a
   * parse of the note, which is what a keystroke in the editor already costs.
   */
  async cycleTheme(): Promise<PreviewTheme> {
    const next = NEXT_THEME[this.themeFor()]
    await this.context.globalState.update(THEME_KEY, next)
    this.redraw()
    return next
  }

  /** Every open preview, drawn again. What both a config change and the toggle
   * come down to — the panels hold no state of their own, so re-rendering the
   * HTML is the whole of applying anything. */
  private redraw(): void {
    for (const [key, panel] of this.panels) {
      const document = vscode.workspace.textDocuments.find(
        (candidate) => candidate.uri.toString() === key
      )
      if (document) this.draw(panel, document)
    }
  }

  show(document: vscode.TextDocument): void {
    const key = document.uri.toString()
    const open = this.panels.get(key)
    if (open) {
      open.reveal(vscode.ViewColumn.Beside, true)
      return
    }

    const dir = dirOf(document.uri)
    const panel = vscode.window.createWebviewPanel(
      "anote.preview",
      `Preview ${nameOf(document.uri)}`,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        // The pictures are read off the disk beside the note, so that directory
        // is a root — and nothing else is. The preview runs no script of its own
        // beyond the reload below, so `enableScripts` stays off.
        localResourceRoots: [dir],
      }
    )

    this.panels.set(key, panel)
    panel.onDidDispose(() => this.panels.delete(key))
    this.draw(panel, document)
  }

  private draw(
    panel: vscode.WebviewPanel,
    document: vscode.TextDocument
  ): void {
    void this.drawAsync(panel, document)
  }

  private async drawAsync(
    panel: vscode.WebviewPanel,
    document: vscode.TextDocument
  ): Promise<void> {
    const text = document.getText()
    const base = panel.webview.asWebviewUri(dirOf(document.uri)).toString()
    const parsed = parseNote(text)
    const blocks = withResolvedUrls(parsed, base)
    // Inlined rather than linked, unlike the pictures: an SVG in an `img` cannot
    // be styled by the page around it, and a diagram has to scale to the column.
    const drawings = await drawingsIn(
      parsed,
      document.uri,
      assetsDirFor(filenameOf(document.uri), this.configs.for(document.uri))
    )

    // Over what the page is made of rather than the page itself, which cannot be
    // hashed before it is rendered. It is only here because `page` asks for one:
    // this preview is pushed rather than polled, so nothing reads the version.
    const version = createHash("sha1").update(text).digest("hex").slice(0, 16)
    const name = nameOf(document.uri)

    panel.webview.html = page(
      name,
      version,
      /* No heading of the note's own name. The filename is on the tab already —
         `page` spends it as the `<title>` — and repeating it as an `<h1>` gave
         every note a heading it does not have, above the heading it does. */
      `<article>${renderNote(blocks, drawings)}</article>`,
      this.themeFor(document.uri)
    )
  }
}

/** Where the chosen palette is kept. Namespaced, because `globalState` is one
 * bag shared by everything this extension ever stores. */
const THEME_KEY = "anote.previewTheme"

/** What the toggle command means by "the next one". */
const NEXT_THEME: Record<PreviewTheme, PreviewTheme> = {
  auto: "light",
  light: "dark",
  dark: "auto",
}

/**
 * The picture each drawing in the document was last exported as, by id.
 *
 * Read from `<assets>/<id>.svg`, which the editor writes whenever a drawing is
 * saved — this side has no Excalidraw and could not draw a scene if it wanted to,
 * since that needs a canvas and a font stack. Only what this app exported: the file
 * is one of ours, but it is being inlined into a page, and a `.svg` that is not an
 * SVG is markup going straight into the document.
 *
 * The directory's name is passed in rather than built here, because
 * `assets.dirSuffix` in `anote.config.json` is what decides it and one caller
 * that knows the workspace is better than a rule written down twice.
 */
async function drawingsIn(
  blocks: NoteBlock[],
  note: vscode.Uri,
  assetsDir: string
): Promise<Map<string, string>> {
  const dir = vscode.Uri.joinPath(dirOf(note), assetsDir)
  const drawings = new Map<string, string>()

  await Promise.all(
    drawingIdsIn(blocks).map(async (id) => {
      try {
        const bytes = await vscode.workspace.fs.readFile(
          vscode.Uri.joinPath(dir, `${id}.svg`)
        )
        const svg = Buffer.from(bytes).toString("utf8")
        if (svg.trimStart().startsWith("<svg")) drawings.set(id, svg)
      } catch {
        // Never exported. The page says so.
      }
    })
  )
  return drawings
}

function dirOf(uri: vscode.Uri): vscode.Uri {
  return uri.with({ path: uri.path.slice(0, uri.path.lastIndexOf("/")) })
}

/** The note's own filename, extension and all — what the assets directory is
 * named after. */
function filenameOf(uri: vscode.Uri): string {
  return uri.path.split("/").pop() ?? "note"
}

/** What to call the note on the page: its filename without the `.note`. */
function nameOf(uri: vscode.Uri): string {
  return filenameOf(uri).replace(/\.note$/, "") || "Note"
}
