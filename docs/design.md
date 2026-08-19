# ANote, a notes extension for VS Code

The app's Notes panel, rebuilt as an extension: a block editor with a `/` menu,
tables, pictures kept beside the note, a preview — and the studio, which is the
same editor and a sidebar of the folder's notes, served to a browser tab.

It is a **spike**, written to answer one question — does the panel's architecture
survive the move? — and the answer is in the shape of the thing: what carried over
is the editor and the renderer, and what disappeared is everything that existed to
put them on screen.

## Running it

```bash
bun install
bun run build
```

Then `F5` in this folder — VS Code opens an Extension Development Host with
`sample/` as its workspace. Open `sample/Welcome.note`.

`sample/` is a demo of the whole thing rather than a scratch folder, and it is meant
to be read in this order:

| Note                                 | What it is for                                              |
| ------------------------------------ | ----------------------------------------------------------- |
| `Welcome.note`                       | what this is, four things to try, and where the files go     |
| `Tour/1. Blocks.note`                | every block the `/` menu makes, and the keys that beat it    |
| `Tour/2. Pictures and drawings.note` | a picture, a drawing, a clip, an attachment — and their folder |
| `Tour/3. Previews and the studio.note` | the two previews, the studio, the port, the commands       |
| `Tour/4. Notes an agent can edit.note` | the MCP server: the seven tools, and what they refuse      |
| `Markdown.md`                        | the same editor over a `.md`, via **Open as Note**           |
| `spec.note`                          | a note holding blocks this build has no spec for             |
| `Examples/`                          | two notes doing work rather than describing themselves       |

Nothing in there is a screenshot: the diagrams are real Excalidraw scenes the
drawing block opens and re-exports, and the picture, the clip, the sound and the PDF
are generated rather than recorded — which is what keeps the whole demo under 500KB.

**It has not been run in VS Code yet.** It typechecks, all four bundles build, and
the previews and the studio's server have tests (`bun run test`), but the editor host I was
written in cannot launch a GUI, so the first `F5` is yours. Expect the first run
to turn up something small.

## A note is a file

`*.note` — a JSON array of BlockNote blocks, opened by a
`CustomTextEditorProvider`. That one decision is why this extension is smaller
than the panel it comes from. Gone, because VS Code already does it:

| The panel has                                       | Here it is             |
| --------------------------------------------------- | ---------------------- |
| Its own note tree, nesting, drag to reparent        | The Explorer           |
| Rename in the row, delete that counts what it takes | The Explorer           |
| Its own tab strip                                   | VS Code's tabs         |
| A store that debounces a write per note, 400ms      | The dirty dot and `⌘S` |
| `notes.json` — a listing beside the bodies          | The filesystem         |
| A loopback HTTP server for the preview              | A second webview       |

What is left is what the panel actually was: the editor, the pictures, the
rendering.

## A markdown file is a note too

`*.md` opens in the same editor, and the whole difference is one conversion and
one shorter list of features.

**Opening one.** `.md` is registered as an *option*, not the default: VS Code
still opens markdown in its own editor, and this one is reached through **Open as
Note** (the Explorer's context menu, the editor's title bar, or the palette),
`Reopen Editor With…`, or a line in `workbench.editorAssociations` for whoever
wants it always. A `.note` has no other editor and opens here by default; a
markdown file has one, and taking it in every repository somebody clones is not
this extension's to take.

**What crosses the bridge is still blocks.** The host reads the file with
`markdownToBlocks` before the webview sees it and writes it back with
`blocksToMarkdown` on every edit (`host/note-markdown.ts`, the same pair the MCP
server has always used). The webview never sees markdown and never learns to
write it — `format` in `protocol.ts` is the only thing it is told, and the only
thing it does with it is have fewer features.

**The features markdown cannot keep are taken out of the schema, not off the
menus.** BlockNote binds `Mod+U` to underline and `Mod+Shift+6` to a toggle list,
and it builds its slash menu out of the schema — so a feature that is only hidden
is a feature somebody still reaches, and reaches into a file that cannot hold it.
Over a `.md`:

| Gone                                          | Because                                           |
| --------------------------------------------- | ------------------------------------------------- |
| Underline                                     | No markdown syntax. Spec removed, so `Mod+U` is a no-op |
| Toggle lists                                  | Come back as bullets. Spec removed, so `/toggle` is not built |
| Tabs                                          | A group of three comes back as three headings     |
| Text and background colour, alignment         | Block *props* rather than specs — off the toolbar and out of the drag handle's **Colors** submenu |
| Coloured table cells                          | `tables` is left at BlockNote's own defaults       |
| Dragging a picture wider or narrower          | The width has nowhere to be written — the handle is hidden in `theme.css` |

**What stays** is everything markdown has no syntax for but which survives the
trip whole: a drawing, a video, an audio clip, an attachment. Those ride in a
`<!-- note … -->` comment, exact on the way back and ignored by every other
markdown reader — the mechanism `note-markdown.ts` was built around.

**The one thing to know before typing in somebody else's markdown.**
`markdownToBlocks` is a subset by design — reference links, raw HTML blocks and
setext headings are read as the paragraphs they look like — and the first
keystroke rewrites the whole file in this extension's own dialect. Hard-wrapped
paragraphs come back as one line each. So opening a `.md` whose round trip is not
the same file says so, once, in a warning: the file on disk is untouched until
something is saved. After the first save it is stable — a second trip through the
converters is a no-op.

Only the editor knows about `.md`. The preview, the studio and the MCP server
still read `.note` and nothing else.

## `anote.config.json`

One optional file at the root of a workspace folder, and **ANote: Open
Configuration** writes it with the defaults filled in. Every key is optional;
the whole file is optional.

```jsonc
{
  "$schema": "https://anote.dev/schemas/anote.config.json",
  "notesDir": ".", // where New Note writes, and what the MCP server reads
  "newNote": { "defaultName": "Untitled" },
  "assets": { "dirSuffix": ".assets" }, // <note>.note.assets — the folder beside a note
  "preview": {
    "theme": "auto", // auto | light | dark: the palette a page starts on
    "pollMs": 2000, // how often a note open in a browser asks if it changed
    "port": 0, // 0 lets the OS pick; a number is a URL you can bookmark
  },
  "studio": {
    "enabled": true, // the studio is the one thing here that accepts a write from outside
  },
  "mcp": { "enabled": true }, // whether these notes are offered to the editor's agent
}
```

Three things about it are deliberate.

**It is a file in the repository, not a VS Code setting.** Where notes live and
what the folder beside them is called are facts about the repository — they are
the same for everyone who clones it, and they belong in the clone. What palette
_you_ read previews in is not, which is why **ANote: Switch Preview Theme** is
in `globalState` and overrides `preview.theme` once you have pressed it.

**Nothing in it can stop the extension starting.** A value that does not check
out is replaced with the default and reported in one warning; the rest of the
file is still read. `src/config.ts` is where that happens and it throws nothing
— see `test/config.ts`, which is mostly a list of bad configs and the assertion
that each one still activates.

**Two of the keys become paths, and both are checked there rather than at the
call sites.** `notesDir` must stay inside the workspace folder, because it is
the root an agent gets handed. `assets.dirSuffix` is joined onto a filename, so
it is letters, digits, dot, dash and underscore and nothing else — which is what
lets `assetsDirFor` be a string concatenation everywhere it is used.

The file is watched. Writing it redraws the open previews and re-offers the MCP
servers; it is not a reason to reload the window.

`preview.port` is the one setting with a security note on it, and it is a short
one: it picks the port, not the interface. The server binds loopback either way, and
that part is not configurable — a page reachable from the network is somebody's own
writing on the network, and a *studio* reachable from the network is somebody else's
write access to it.

It is called `preview.port` and it is **the** port: one server answers both the
pages and the studio. `studio.enabled` is the switch for a workspace that would
rather the writable half did not exist — off means those routes are not mounted at
all, not that a command refuses.

## How it hangs together

```
extension host (Node)                     webview (browser)
─────────────────────                     ─────────────────
note-editor.ts  ─── init / external ────▶  main.tsx ─┐
                ◀── edit ────────────────  (BlockNote)│
                ◀── uploadFile ──────────             │ editor.tsx
                ─── uploaded ───────────▶             │ (one copy,
preview.ts ── note-html.ts ─▶ a second panel          │  two hosts)
                                                      │
studio.ts ── studio-routes.ts ─┐
                               │
preview-pages.ts ──────────────┴─ note-server.ts ═ HTTP ═▶ studio/main.tsx ─┘
  /read/<note>   (finished HTML)   (one loopback port)      / (a browser tab)

a process of its own (Node)
───────────────────────────
mcp/main.ts ── note-markdown.ts ─▶ *.note, over a pipe
```

The last one has no arrow to the others on purpose: it shares the _format_ with
them and nothing else. See below.

The studio's arrow is the interesting one, because `editor.tsx` is on both ends of
the diagram and there is only one of it. What changes between the two hosts is a
`Channel` — `postMessage` on one side, `fetch` on the other — and that is the whole
of what "does the panel's architecture survive the move?" turned out to mean.

## Two previews, on purpose

**Open Preview to the Side** is a webview: in the editor, follows the theme (or
whichever one you pinned — see below), redrawn from `onDidChangeTextDocument`.

**Copy Preview Link** / **Open Preview in Browser** is the app's own preview
server, lifted over — `http://127.0.0.1:<port>/read/auth/login.note`, opened in
Chrome beside whatever the note documents, or handed to something that fetches pages
rather than looks at them. Loopback, a port the OS picks, and the note's own path in
the workspace so a copied link says which note it is. The `/read/` prefix is there
because the studio is on the same port — see below.

In front of it sit two checks that do not depend on a secret — the request has to
have arrived addressed to `127.0.0.1` (or `localhost`), which is what stops a site
pointing its own name at loopback to read the answers, and a fetch some other origin
started is refused. The path that arrives is a key and never a filename, so there is
no traversal to guard. **A link lives as long as the window.**

Which notes have a page: the ones somebody asked for a link to, plus — since the
merge — any `.note` under the folder the studio is mounted on. The registry is now
the mechanism for notes the studio *cannot* name (outside `notesDir`), rather than
the whole of what is not served. What that widening is worth is in
`noteAt` in `note-server.ts`: a `.note` in the folder became readable without the
token by something that gets past the two checks above, which means a process on
this machine, which could read the file off disk anyway.

Two things there are worth knowing:

- **`vscode.env.asExternalUri`** is what makes it work with VS Code attached to a
  remote — SSH, WSL, a container, a Codespace. The extension is running _there_, so
  `127.0.0.1:<port>` on that machine is not somewhere the browser here can go; that
  call sets up the forwarding. It is one line, and it is a thing the desktop app
  cannot do at all.
- **The reload poll went back in.** `note-html.ts` carries it in the app, I dropped
  it when copying (a webview is pushed, not polled) — and then a browser tab needed
  it again, because a browser has no channel to be told the note changed. It is
  injected by `preview-pages.ts` now, where being served over a socket is the
  reason for it, rather than in the shared renderer where it was wrong half the
  time.

### Light and dark

Both previews carry both palettes and pick between them with one attribute —
`data-theme` on `<html>`, `auto` by default, which means _the surface's own
light/dark_: VS Code's theme in the webview, the reader's browser in the served
page. **ANote: Switch Preview Theme** (the `$(color-mode)` button on the preview's
title bar) moves it on: editor → light → dark → editor.

The two previews reach it differently, and the split is the same one the reload
poll is on:

- The **webview** re-renders. `enableScripts` is off there — the whole reason this
  preview is server-rendered is that it needs no script — so redrawing the HTML
  with `data-theme` set _is_ the switch, and the choice lives in `globalState` so
  the next window opens the way this one closed.
- The **served page** switches in the tab, with a pill in the corner and the
  attribute written from `localStorage` in the `<head>` before the first paint (a
  reader who asked for dark should not get a flash of white first). The server
  never learns which way they read it; the origin is a loopback port this run
  picked, so the memory lasts as long as the link does.

The dark palette is one string in `note-html.ts` emitted under two guards, because
a palette that is only correct while two copies agree will stop being correct. One
of those guards is `body.vscode-dark`, the class VS Code stamps on a webview's
body — belt and braces beside `prefers-color-scheme`, which is the same question
asked the way the web asks it.

### One type scale, written twice

The editor and the previews were never set in the same type, and it showed: the
body drew at `var(--vscode-font-size)` — **13px** — in the editor and 16px on the
page, the line height was 1.5 against 1.65, and the heading scales _crossed_, with
BlockNote's h1 at 3em against the page's 2em but its h3 at 1.3em against 1.17em. No
uniform scaling reconciles two curves that cross.

They now share one scale, and **it is the document's rather than the editor's**:
16px/1.65, headings 2.2 / 1.6 / 1.3 / 1.1 / 1 / 0.9em, 12px between blocks, a 78rem
measure. The cost is stated plainly — the note body no longer follows VS Code's UI
font size — and the reason is that the surface which _cannot_ follow a setting, a
page open in Chrome, is the one the other two have to meet. VS Code's own markdown
preview makes the same trade.

It is written twice because it cannot be written once: `webview/theme.css` is a
file bundled into a webview, `page()` in `note-html.ts` is a `<style>` built as a
string in Node, and the browser preview can read neither that file nor a
`--vscode-*` variable. Both ends carry a comment pointing at the other; they are
only correct while they agree.

One thing that is _not_ symmetric, deliberately: the air above a heading is a
`margin` on `.bn-block-outer` in the editor rather than padding on the content,
because BlockNote positions the drag handle from the block's own bounding rect —
padding would grow that rect and leave the handle sitting alone in the gap.

Nothing the loopback port is built from imports `vscode`: what a page needs of a
note — the text, and the bytes of a picture beside it — arrives as functions, the way
the app's server takes a `NoteSource` instead of importing its store, and the studio
takes a `StudioWorkspace` for the same reason. That is why `test/preview-pages.ts`
and `test/studio-routes.ts` can bind a real server and fetch real pages with no
editor in sight, and it is most of what a test in this repo can reach.

## The studio

**ANote: Open Studio in Browser** serves the notes folder as a page you can edit
in: the notes down the left, the same block editor on the right, on
`http://127.0.0.1:<port>/?note=auth/login.note` — **the same port the pages are
on**. It is the third surface a note appears on and the only one that is neither of
the other two: the custom editor is a webview VS Code owns, the served preview is
finished HTML nobody can type into, and this is the editor itself, in Chrome.

One link, and one click each way between the two surfaces: a page carries **Edit**
(top right, beside the theme switch) and the studio carries **Open as page**. Both
are plain `<a>` hrefs — the page stays HTML that needs nothing to run, which is the
whole reason it exists next to an editor that does.

It cost two files. `studio/channel.ts` answers the editor's own messages
(`uploadFile`, `writeAsset`, `readAsset`) out of `fetch` calls instead of
`postMessage`, and `studio/studio.css` **defines the `--vscode-*` variables** that
`webview/theme.css` is written against — so the 825-line stylesheet that themes
BlockNote for VS Code was reused rather than forked, by handing it the palette
VS Code would have. Everything else in `src/studio/` is what a webview never had to
think about because VS Code was doing it: which note is open, when to save, and what
to do when the file changed underneath.

Three things about it are worth knowing.

**One server, and what merging cost.** It started as two servers on two ports —
the pages are deliberately a read, and every sentence true of them is false
of the studio, which lists the folder, opens anything in it, and writes. Merging
them bought the one link and the two buttons above, which only work on one origin.
What it cost was the isolation two origins gave for free, and the place that shows is
the page: a note's drawings are inlined as SVG, and an SVG is markup, so a crafted
`.svg` in an assets directory was already script on the page's origin. On its own
port that origin held other notes; on this one it also holds the studio's API and the
token is in the document at `/`. Hence the nonce-based CSP on the studio's page: an
injected inline `<script>` has no nonce and does not run. The hole predates the
merge — the merge is what made it worth closing.

The port is `note-server.ts`; the two surfaces are `preview-pages.ts` and
`studio-routes.ts`, neither of which owns a socket. What both halves must not
disagree about is in `host/http.ts`: the interface bound, the two checks in front of
it, the range slicing, and the ETag.

**Every write carries a token, and every save carries a version.** The two checks a
page stops at (`Host`, `Sec-Fetch-Site`) are enough for a read: anything on
this machine that could forge them could read the `.note` off disk instead. They
are not enough for a write, because a page in a browser cannot read your workspace
but *can* be talked into posting at a loopback port. So `/api/` requires a
per-run token in a header — minted per server, handed only to the page the server
served, and a custom header the browser will preflight and this server will not
answer. Then, separately: a save says which version of the note it is replacing and
is refused if the file has moved on, which is the only reason it is safe to have one
note open in the studio and in a VS Code tab at once. The studio offers you the
choice at that point rather than picking one.

**It does not rename, move or delete.** Same line the rest of the extension holds:
those are the Explorer's. Creating a note is there, because a sidebar with no `+`
sends you back to VS Code to do the one thing you came to start.

Two smaller notes. `/files/` serves a note's pictures and clips and **only what is
inside a `<note>.assets` directory** — `notesDir` defaults to the workspace folder,
so "any file under the root" would have been this extension serving a repository
over a socket. And the studio is **one folder at a time**: opening it on a second
folder of a multi-root window *moves* it — the port and the link stay, the sidebar
changes, and an open tab notices at its next poll. Asking for a page's link mounts
the studio on that note's folder too, which is what makes the **Edit** button on the
page work without a second command having been run first.

## The bridge

`src/protocol.ts` is the only thing both sides read. That is the app's own rule —
the main process and the renderer never import each other, everything crossing
goes through one file — and it is the reason the editor moved over nearly
untouched: a webview is the same boundary with `postMessage` where
`ipcRenderer.invoke` was, so the port is a new bridge rather than new call sites.

Three things are worth reading the comments for, because each is a bug that looks
like a feature that does not work:

- **The echo guard** in `note-editor.ts`. An edit from the webview is applied to
  the document, which fires a change event, which would send the text back to the
  webview that just wrote it — and the editor rebuilds for text it did not write,
  so the caret would jump to the top of the note on every keystroke.
- **`retainContextWhenHidden`** in `extension.ts`. Off, every tab switch tears the
  webview down and takes the caret, the scroll and the undo history with it. On,
  every open note holds a live webview. The app solves this by keeping an editor
  mounted per tab and hiding the ones off screen; a webview has no equivalent.
- **`resolveFileUrl`** in `webview/editor.tsx`. The app registers a `note-file://`
  scheme and Chromium fetches pictures directly; a webview may only load a URL
  that `asWebviewUri` produced, and BlockNote has exactly this hook for it.

## Pictures

A dropped, pasted or chosen file is read to base64 in the webview, written by the
host into `<note name>.note.assets/` beside the note, and the document keeps a
**path relative to the note** — so the note and its pictures move, commit and get
deleted together, and what is written down is the same string on every machine.
`localResourceRoots` is the note's own directory and this extension's bundle, and
nothing else.

## `/drawing`

Excalidraw, in a dialog over the note. The block holds only an id; the scene is
`<note>.assets/<id>.excalidraw` and the picture exported from it is `<id>.svg`
beside it — so a note with five diagrams is not five copies of Excalidraw's JSON
inside the file the editor rewrites on every pause in the typing.

The exported SVG is what **both previews** render, because neither can run
Excalidraw: one is a webview with no canvas mounted, the other is a Node process. A
drawing that has never been saved says so instead of leaving a gap.

Two things this needed that pictures did not:

- **A read.** The upload channel only wrote, and under a name the _host_ invented.
  A scene is written repeatedly under a name the document already holds, so the
  protocol grew `writeAsset`/`readAsset` — the webview names the file, and
  `assetUri` refuses anything that is not an id, a dot and a short extension.
- **Fonts.** Excalidraw resolves them at runtime against
  `window.EXCALIDRAW_ASSET_PATH`, and left unset that is `esm.sh` — a network fetch
  from a page whose CSP allows none, for files the package ships. The host sets it
  to the bundle directory's webview URI and `esbuild.mjs` copies the fonts there.

**The cost, stated plainly: `dist/webview.js` is 9.5MB.** Excalidraw is bundled
eagerly because esbuild's code splitting needs `format: "esm"`, a
`<script type="module">`, and `'strict-dynamic'` in the CSP for the dynamic import
— three changes I could not test, where the failure mode is a blank editor. The
`await import()` calls are written as if it were split, so turning it on is a build
change and not a code one. The fonts add 16MB to `dist/`, which is the whole tree;
a real extension ships only the families its defaults use.

## A note something other than a person can edit

`src/mcp/` is the notes folder as an [MCP](https://modelcontextprotocol.io) server:
a process a model's client starts, with seven tools over the same `.note` files
this extension edits.

```bash
bun run build          # dist/mcp.js falls out with the other two bundles
node dist/mcp.js       # the folder it is started in, or argv[2], or $ANOTE_ROOT
```

`.mcp.json` at the root registers it for anything that reads one, Claude Code
included. **It imports no `vscode`** — reading and writing a note needs a
filesystem and nothing else, which is the dividend a note being a file pays.

**For the editor's own agent there is nothing to register.** `mcp-provider.ts`
contributes the server through `lm.registerMcpServerDefinitionProvider`, so
installing the extension is the whole of the configuration: one server per
workspace folder, each with that folder as its root, the shipped `dist/mcp.js` as
its bundle, and `process.execPath` as its command so the machine needs no `node`
of its own. Every other client has to be told a path and a folder by hand; this
one is already running in the window whose folders those are. It is why
`engines.vscode` is `^1.101.0`.

| Tool           | For                                               |
| -------------- | ------------------------------------------------- |
| `list_notes`   | every `.note` under the root                      |
| `read_note`    | `markdown` \| `outline` \| `json`                 |
| `create_note`  | a new one, from markdown                          |
| `append_note`  | to the end, touching nothing above it             |
| `edit_note`    | named blocks, by id — all the ops or none of them |
| `write_note`   | the whole note, and it argues first               |
| `search_notes` | a phrase, and the lines it is on                  |

**Two documents, not one.** Markdown is what a note _says_; the outline is what it
is _made of_ — one line per block, id first. Reading a whole note to change one
paragraph is what this is built to make unnecessary: read the outline, replace the
block. And **a block that was not edited keeps its id**, because the editor holds
the caret, the undo stack and the selection by block id — a write that mints fresh
ids for a note somebody has open is a note that jumps under them.

### What it does about lossiness

`note-markdown.ts` is BlockNote's two converters written as a walk over the blocks,
for the reason `note-html.ts` gives: they are methods on an editor, an editor is
ProseMirror, and ProseMirror is a DOM. Writing them by hand is what let the round
trip be the design constraint rather than an afterthought:

- **The blocks markdown has no syntax for are carried, not dropped.** A video, an
  audio clip, an attachment, a drawing, a block from a later version of the editor —
  each becomes an HTML comment holding the block itself, invisible where markdown is
  rendered and exact on the way back. Deleting one is then a decision rather than an
  accident.
- **What markdown genuinely cannot carry, it names before it costs you anything.**
  Colours, alignment, underline, merged cells, column widths. `write_note` refuses a
  rewrite that would lose any of them and says which, and takes `force` if you meant
  it. `edit_note` never has to ask, because it only touches the blocks you named.

### The block types are a contract, and it is enforced three times

A note is a file, so a note can hold a block this build has no spec for — one from
a later version, from the desktop app, or from an extension of BlockNote's that
this schema does not include. `sample/spec.note` is the real case: it carries
`columnList` / `column` from `@blocknote/xl-multi-column`, which is not installed.
BlockNote's answer to that is `throw Error("node type columnList not found in
schema")` from inside `blockToNode`, during construction, during render — so React
unmounts and the panel is **white**, with the failure in a console nobody opened.

The first fix here was to check the document first and refuse it with a readable
message. That is honest and it is still the wrong answer, because **a note is not
one block**: the two unknown types in `spec.note` are wrappers, so refusing the
file held every ordinary heading, table and list in it hostage to them.

So the unknown ones are **folded**, on the way into the editor, into a read-only
listing of their own JSON — the same answer markdown gives for something it cannot
express — and **unfolded** back on the way out. The rest of the note is an ordinary
document. The whole block, its id, props and children in their original key order,
rides in a prop and is written back byte for byte, so opening a note costs no undo
step and no dirty dot; `test/note-schema.ts` holds the round trip to that against
`sample/spec.note` itself. Read-only on purpose: hand-editing JSON inside a block
editor would mean a typo silently rewriting a block nothing here understands. Move
it, delete it, or replace it with the MCP server.

`note-schema.ts` is the one fact both sides need, and it is spent in four places:

- **The webview folds rather than refuses**, and the placeholder says which type it
  stands for. An error boundary still wraps the editor for everything that is
  genuinely a fault — every render failure used to have the same white symptom.
- **`read_note` and `list_notes` warn**, at the top of the answer and on the line,
  because a model handed a note that reads perfectly has no other way to learn that
  part of it is not editable — and the warning says how to fix it.
- **The write tools refuse to introduce one.** Markdown cannot express an
  unsupported block, so the only way through is the comment marker — and a write
  that adds a type the note did not already have is refused outright. A type it
  _did_ have is carried, because refusing that would make such a note unfixable.
- **The server's `initialize` instructions name the whole list**, so the rule is
  known before anything is called rather than learned from a refusal.

The list is a copy — the truth is `Object.keys(schema.blockSchema)` in a browser
module the server cannot import — so `editor.tsx` compares the two on load and
says so in the console when they have drifted.

### The one thing it cannot see

VS Code writes nothing to disk until the note is saved, and does not reload a
document it has unsaved changes in. So a write from the server into a note that is
open and **dirty** is a write the next `⌘S` silently undoes — and nothing outside
the editor can find that out. Every tool that writes says so in its description.

Closing it properly means the server running _inside_ the extension host and
writing through `workspace.applyEdit`, so an edit lands in the open document rather
than under it: live in the editor, undoable, and dirty-dotted like any other. That
is a different program from this one and it is the next one to write.

## What it does not do yet

- **Templates.** In an extension the honest version is a folder of `.note` files
  and a "New note from template…" command, not a second listing.
- **`⌘F`.** Find does not work inside a webview. Workspace search still finds a
  note, but it is searching JSON.
- **The MCP server writing into an open, unsaved note.** It writes the file; the
  editor has the document. See above. (The studio does not have this problem: it
  reads the open document's text and writes through a `WorkspaceEdit`, then saves.)
- **Rename, move and delete in the studio.** Deliberate, but it is the first thing
  somebody will miss in a browser tab where there is no Explorer to fall back on.
- **The studio's page has not been opened in a real browser yet.** Every route is
  exercised over a socket by `test/studio-routes.ts`, and the bundle builds — but
  the first render is yours, like the first `F5`.
- **Activation for the MCP provider is VS Code's implicit one**, generated from
  the `mcpServerDefinitionProviders` contribution rather than declared here — the
  same way `customEditors` activates this extension today. If **MCP: List
  Servers** does not show "ANote" in a fresh window, that is the assumption
  breaking, and the fix is one `onStartupFinished` in `activationEvents`.

## The CSP is load-bearing

`default-src 'none'` covers every fetch a directive does not name, so a directive
missing from the list is a feature that silently does not work rather than an error
anybody sees. That is exactly how `<video>` and `<audio>` came to be dead in the
editor: `img-src` was there and `media-src` was not, so pictures loaded and clips
never played.

## Two things the port got wrong, and what they looked like

Both were single lines dropped while carrying the app's drawing block over, and both
are in the app's own stylesheet with the reason written beside them:

- **A drawing collapsed to a thin column instead of filling the note.** BlockNote
  lays a block's content out with `display: flex`, so the block is a flex item and
  takes its width from its contents — and its contents are an SVG deliberately
  stripped of `width` and `height` so that it scales to the column it is given. Each
  waits for the other. `width: 100%` is the whole fix.
- **A drawing sat on a white card in a dark editor.** Downstream of pinning the
  block's export to `exportWithDarkMode: false`: Excalidraw _inverts_ strokes for a
  dark export rather than tinting them, so a light export on a dark editor is black
  lines nobody can see — and a white background behind it is papering over that
  rather than fixing it. The block follows the editor's theme now (`theme.ts` is how
  a block several layers down inside BlockNote finds out), and the copy written
  beside the scene for the previews stays light, because those pages have only the
  one rendering.

## Two decisions to revisit before this becomes real

**The `mantine` view instead of the app's `shadcn` one.** That build is a vendored
set of shadcn components styled with Tailwind classes, so it needs a Tailwind build
in whatever consumes it; this one carries its own CSS. The editing experience is
the same — the `/` menu, drag handles, the formatting toolbar, resizable tables —
the menus and panels look slightly different. Bringing Tailwind in would close the
gap.

**JSON, or markdown?** The app keeps blocks as JSON deliberately: BlockNote's
markdown export is lossy by its own documentation, and a note serialised through a
converter while it is being typed into quietly loses what the converter has no
block for. `docs/design.md` records that trade, and its cost: a file no other
editor can read.

**In VS Code that trade tips the other way**, because the whole environment is
built on text files. Markdown-backed would be greppable, diffable, openable in the
plain text editor beside this one, and readable by every other extension — and the
preview would come free from VS Code's own, which means deleting `note-html.ts`
(707 lines) and `preview.ts` with it. Against that: Crepe, the markdown-native
editor this app used before BlockNote, cannot resize table columns without reaching
into someone else's node view, which is why the app left it.

Worth deciding on purpose rather than by inheritance.

**`note-markdown.ts` moves that argument without settling it.** The half of the
case that was about _reach_ — greppable, diffable, readable by other tools — is now
answered without changing what a note is: markdown is a conversion away in a Node
process, in both directions, and `src/mcp/` is what that buys. What is left of the
case is genuinely about the file: the plain text editor beside this one, VS Code's
own markdown preview, and a diff a person reads. Those still want the note to _be_
markdown, and the converter's own carried-in-a-comment blocks are the honest
measure of what that would cost.

## Files

```
src/protocol.ts          the contract, types only
src/config.ts            anote.config.json: the shape, the defaults, the checks
src/note-schema.ts       which blocks the editor can open — shared with the server
src/host/extension.ts    activate, and the commands
src/host/config.ts       anote.config.json per workspace folder, watched
src/host/note-editor.ts  the custom editor: webview, edits, uploads
src/host/preview.ts      the preview panel (a webview)
src/host/note-server.ts  the port: one socket, both surfaces, the token
src/host/preview-pages.ts   a note as finished HTML, and the Edit link
src/host/http.ts         what everything on that port must not disagree about
src/host/studio.ts       the studio, as this editor's notes folder
src/host/studio-routes.ts   the studio: lists, opens, and writes
src/host/note-html.ts    copied from the app's main/note-html.ts
src/host/note-blocks.ts  parse, and resolving relative URLs
src/host/note-files.ts   what a dropped file is stored as
src/host/note-markdown.ts  markdown, both ways, with no editor mounted
src/host/note-format.ts  .note or .md, and the conversion between them
src/host/mcp-provider.ts   the server, handed to the editor's own agent
src/mcp/main.ts          the MCP server: JSON-RPC over stdio
src/mcp/tools.ts         the seven tools
src/mcp/workspace.ts     the notes folder, as files
src/webview/main.tsx     the message loop
src/webview/editor.tsx   BlockNote
src/webview/bridge.ts    postMessage, and the one call that has an answer
src/webview/unsupported.tsx  a block with no spec, as a listing of itself
src/webview/theme.css    --bn-* mapped onto --vscode-*
src/studio-api.ts        the routes and headers, both sides read it
src/studio/main.tsx      which note is open, when to save, what if it moved
src/studio/channel.ts    the editor's messages, answered out of fetch calls
src/studio/api.ts        one place where a fetch happens
src/studio/sidebar.tsx   the tree the extension does not otherwise need
src/studio/studio.css    the palette VS Code would have given it
test/config.ts           the config, and the two settings that become paths
test/preview.ts          the renderer, which needs no VS Code
test/preview-pages.ts    a note as a page, over a real socket
test/studio-routes.ts    the writable half: the token, the version, the paths
test/note-schema.ts      folding an unknown block, and getting it back
test/note-markdown.ts    markdown, out and back
test/note-format.ts      what gets written over a .md, and what refuses to
test/mcp.ts              the tools over a real folder, then the server over a pipe
```

`note-html.ts` and `note-blocks.ts` are **copies**, because the two are separate
packages with separate builds. That is a fork and it will drift; a real port shares
them through a workspace instead.
