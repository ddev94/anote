# Markdown, as blocks

This file is here to be opened with **Open as Note** — right-click it in the Explorer, or use the button in the title bar while it is open as text. VS Code keeps its own markdown editor as the default; this extension asks for `.md` as an option, not as a habit everybody who clones a repository has to inherit.

What crosses the bridge is still blocks: the host converts the file before the webview sees it and converts it back on every edit. The editor never learns to write markdown — it is only told to have fewer features.

## Everything below survives the trip

- Bullets, and _italic_, **bold**, `code` and ~~strike~~
- [Links](https://code.visualstudio.com), and pictures filed beside the file
- Nesting, one level at a time

  - like this

- [x] Checklists
- [ ] Both ways

1. Numbered lists
2. Which renumber themselves

> Quotes, with their own line down the side.

| What | Where it is written down |
| --- | --- |
| Tables | GFM pipes, one row per line |
| Code | A fence, with its language on it |
| Headings | Six levels of `#` |

```ts
const editor: "the same one" = "the same one"
```

---

## What is missing from the menus here

Underline, toggle lists, tabs, text and background colour, alignment, coloured table cells and dragging a picture wider. Markdown has nowhere to put any of them, so they are taken out of the schema rather than hidden on a menu: a feature that is only hidden is a feature somebody still reaches, and reaches into a file that cannot hold it. Open a `.note` beside this file and they are all back.

## And what still works anyway

A drawing, a video, an audio clip and an attachment have no markdown syntax at all — so they ride in an HTML comment, which every other markdown reader ignores and this one reads back exactly. The diagram below is a real drawing block in a `.md` file:

<!-- note drawing {"props":{"drawingId":"e42c6a08-77b5-4d19-9c30-8ab512f7d6e1"}} -->

## One thing to know before typing in somebody else's markdown

The converter is a subset by design: reference links, raw HTML blocks and setext headings are read as the paragraphs they look like, and hard-wrapped paragraphs come back as one line each. So opening a `.md` whose round trip is not the same file says so, once — and the file on disk is untouched until something is saved. After that first save it is stable, because a second trip through the converters changes nothing.
