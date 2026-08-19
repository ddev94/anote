<p align="center">
  <img src="media/icon.png" alt="ANote" width="128" height="128">
</p>

<h1 align="center">ANote</h1>

<p align="center">
  <strong>Write markdown the way you write in Notion, inside VS Code.</strong>
</p>

<p align="center">
  <img src="media/editor.gif" alt="A note in the ANote block editor: typing / opens the block menu, and a table is inserted and filled in" width="900">
</p>

<p align="center">
  <em>The same file, opened as blocks — <code>/</code> for the menu, and a table without one pipe or dash typed by hand.</em>
</p>

Your README, your docs, your notes: still plain `.md` files in the repo, still
diffable, still readable by everyone else. You just stop typing the syntax.

## ✨ The pitch

Editing a README in VS Code has always been the same two-window compromise: raw
markdown on the left, a preview on the right, and you doing the rendering in your
head. Tables are the worst of it, realigning pipes by hand, counting dashes,
re-reading the preview to find the column you broke.

ANote opens the same file as a **block editor**. A `/` menu instead of syntax. A
table you click into and drag columns on. A picture you drop where you want it.
Headings, checklists, code blocks, quotes, all of it typed as it looks.
Save, and it is markdown on disk again, exactly the file git expects.

> Same file. Same repository. None of the syntax.

**Open as Note** on any `.md`, from the Explorer's right-click menu, the editor's
title bar, or the command palette, and it opens in the editor. VS Code's own
markdown editor stays exactly where it is; ANote is an option you reach for, never
a takeover of every `.md` in a repo you cloned.

## 🗂️ And then there is `.note`

Markdown is a lowest common denominator, and some notes want more than it can hold.
So ANote has a format of its own, `.note`, where the editor keeps everything:

- **Drawings**, real Excalidraw scenes, opened and edited in place, not screenshots.
- **Video, audio and attachments**, dropped in and playable in the note.
- **Pictures you can resize**, coloured text and backgrounds, coloured table cells,
  toggle lists, tabbed sections.
- **Files that stay together**, everything you drop is written into
  `<note>.note.assets/` beside the note, referenced by a relative path, so a note and
  its files move, commit and get deleted as one thing.

Design docs, meeting notes, an architecture page with the diagram actually in it —
those are `.note`. The README stays `.md`. Both open in the same editor.

## 👀 Read it anywhere, edit it anywhere

- **Preview to the side**, the rendered note in a webview, following your theme.
- **Preview in the browser**, a link you can copy and open in Chrome beside
  whatever the note documents, in light or dark. Works over SSH, WSL, containers and
  Codespaces.
- **The studio**, a notes folder served as a full page: the notes down the left,
  the same block editor on the right, in a browser tab. The editor, outside the
  editor.
- **Notes your agent can edit**, an MCP server is offered to VS Code's own agent,
  with tools to list, search, read, create, write, append and edit notes. Ask it to
  update a section and it edits that section, leaving the rest of the note untouched.

Everything a notes app usually insists on owning, the tree, rename, move, delete,
tabs, saving, is left to VS Code, because VS Code already does it well.

## 🚀 Getting started

1. Open a folder.
2. Right-click any `.md` → **Open as Note**. That's the whole demo.
3. For a note of your own: right-click a folder → **New Note**, or run
   **ANote: New Note**.

`/` opens the block menu. `⌘S` / `Ctrl+S` saves, like any other file.

## ⌨️ Commands

All under the **ANote** category.

| Command                                     | What it does                                           |
| ------------------------------------------- | ------------------------------------------------------ |
| Open as Note                                | Opens a `.md` in the block editor                      |
| New Note                                    | Creates a `.note` in the chosen folder                 |
| Open Preview to the Side                    | The rendered note, in a webview                        |
| Switch Preview Theme                        | Editor → light → dark                                  |
| Open Preview in Browser / Copy Preview Link | The note as a page on a loopback port                  |
| Open Studio in Browser / Copy Studio Link   | The folder's notes, editable in a browser tab          |
| Export as Markdown                          | Writes a `.note` out as `.md`                          |
| Open Configuration                          | Writes `anote.config.json` with the defaults filled in |

## ⚠️ Good to know about `.md`

The editor is honest about what markdown can hold. Underline, toggle lists, tabs,
colours and picture resizing are **removed from the menus** over a `.md` rather than
offered and then lost on save, a feature you can reach is a feature that has to
work. Drawings, video, audio and attachments do survive: they ride in an HTML
comment every other markdown reader ignores.

One thing to know before typing in someone else's markdown: ANote reads a practical
subset, and the first keystroke rewrites the file in its own dialect, hard-wrapped
paragraphs come back as one line, reference links are flattened. If a file's round
trip is not the same file, ANote says so once, before anything is written. Nothing
touches disk until you save.

## ⚙️ Configuration

One optional `anote.config.json` at the root of a workspace folder. Every key is
optional, and a bad value is replaced with the default and reported in a warning —
nothing in it can stop the extension starting.

```jsonc
{
  "notesDir": ".", // where New Note writes, and what the MCP server reads
  "newNote": { "defaultName": "Untitled" },
  "assets": { "dirSuffix": ".assets" }, // <note>.note.assets, the folder beside a note
  "preview": {
    "theme": "auto", // auto | light | dark
    "pollMs": 2000, // how often a browser tab asks if the note changed
    "port": 0, // 0 lets the OS pick; a number is a bookmarkable URL
  },
  "studio": { "enabled": true },
  "mcp": { "enabled": true },
}
```

## 🔌 The port

The browser preview and the studio share one HTTP server bound to **loopback only** —
`preview.port` picks the port, not the interface, and that is not configurable. Reads
are guarded by `Host` and `Sec-Fetch-Site` checks; every write additionally carries a
per-run token, and every save carries the version of the note it replaces, so a note
open in the studio and in a VS Code tab at once cannot silently overwrite itself.
Links live as long as the window. Set `studio.enabled` to `false` and the writable
half is not mounted at all.

## ✅ Requirements

VS Code 1.101 or later. No other dependencies, everything is bundled.

## 🛠️ Development

```bash
bun install
bun run build   # then F5, which opens sample/ as the workspace
bun run test
```

`sample/` is a guided demo: start at `Welcome.note`, then the `Tour/` notes.

For why any of it is built this way, the file format, the two previews, the studio,
the bridge between host and webview, see [docs/design.md](docs/design.md).

## 📄 License

MIT
