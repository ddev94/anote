import { PREVIEW_THEMES, type PreviewTheme } from "../config";
import type { NoteBlock } from "../protocol";

/**
 * A note, rendered to HTML — the preview, and the one file in this extension
 * that arrived unchanged from the desktop app it comes from (`main/note-html.ts`
 * there).
 *
 * It is worth saying why it ported for free: it is a pure walk over the block
 * model with no DOM, no Electron and no editor in it, so the environment it runs
 * in is not something it has an opinion about. The obvious way to build a
 * preview would have been BlockNote's own `blocksToHTMLLossy`, and it is not
 * available: that is a method on an editor, an editor is ProseMirror, and
 * ProseMirror is a DOM — which in a webview means the preview could only render
 * while the note it is of was open and running.
 *
 * Originally: a note, rendered to HTML in the main process.
 *
 * This is the whole reason the preview is server-rendered: the page a browser
 * — or something reading pages rather than looking at them — receives is
 * finished HTML, with no script needed to put the words on it. BlockNote's own
 * `blocksToHTMLLossy` was the obvious alternative and is not one: it is a
 * method on an editor, an editor is ProseMirror, and ProseMirror is a DOM. That
 * would have meant the renderer rendering every preview and pushing it here,
 * so a note could only be previewed while its window was open and while that
 * note was the one being looked at.
 *
 * What is written here instead is a walk over the same block model, emitting
 * plain semantic HTML — `<h2>`, `<ul>`, `<table>`, `<pre>` — rather than
 * BlockNote's own class-laden markup. That is the better output for this
 * anyway: the page is read, not edited, and semantic HTML is what a reader
 * with no stylesheet gets the structure from.
 *
 * Everything reaching this file came off disk, so nothing is trusted: text is
 * escaped, a URL is checked against a scheme list before it becomes an `href`,
 * and a colspan is an integer or it is not there at all. A note is the user's
 * own text — but this is a page served over a socket, and the one rule of a
 * page served over a socket is that the document does not get to write the
 * markup.
 */

/** The heading levels HTML has. A note written by a schema with more (or a
 * file edited by hand) is clamped rather than refused. */
const MAX_HEADING = 6;

/**
 * What a URL in a note may point at.
 *
 * `data:` is on the list because an image pasted into a note arrives as one —
 * BlockNote inlines it rather than writing a file — so leaving it off would
 * blank exactly the images that are certainly the user's own. `javascript:`
 * and every other scheme are refused: the page is opened in the user's real
 * browser, where a link is a link.
 */
const SAFE_SCHEMES = new Set(["http:", "https:", "mailto:", "data:"]);

/** The pictures the note's drawings were last exported as, by drawing id. Read
 * before rendering starts, because this walk is synchronous and a drawing is a
 * file. */
export type Drawings = ReadonlyMap<string, string>;

/**
 * Which of the page's two palettes to paint it in.
 *
 * `auto` is the surface's own answer and the default — the reader's browser in
 * the served preview, VS Code's theme in the webview beside the editor. The
 * other two are somebody having said otherwise, and they are baked into the
 * markup rather than switched in the page: this document renders in a webview
 * that runs no script, so an attribute on `<html>` is the only place a choice
 * can live that both surfaces can read.
 *
 * The three names themselves live in `src/config.ts`, because `anote.config.json`
 * names one as the palette a preview starts on and a config file and a renderer
 * disagreeing about what `dark` is called is a setting that silently does
 * nothing.
 */
export type { PreviewTheme };

const THEMES = new Set<PreviewTheme>(PREVIEW_THEMES);

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * A URL fit to put in an `href` or `src`, or null. Parsed rather than
 * pattern-matched: `java\nscript:` is not a scheme to a parser.
 *
 * **What changed on the way over is which relative URLs count.** The app parses
 * against a base, so every relative URL resolves and passes. Here the two previews
 * want different things from that, and the split below is the one that satisfies
 * both: a *root*-relative URL is one this page's own server built and is kept; a
 * *document*-relative one is a leftover the resolver refused, and is refused again
 * so the page says what the file was rather than emitting a `src` that cannot load.
 */
function safeUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;

  /*
   * A **root-relative** URL is one this page's own server built — the file route in
   * `preview-pages.ts`, which is how a clip gets a player. Kept relative on
   * purpose: with the preview opened through a forwarded port, an absolute
   * `127.0.0.1:<port>` inside the page would point at a host the browser cannot
   * reach, while a path resolves against whatever URL the page was actually
   * fetched from.
   *
   * `//host` is not that. It is protocol-relative, which is an absolute URL to
   * somewhere else wearing a path's clothes.
   */
  if (value.startsWith("/"))
    return value.startsWith("//") ? null : escapeHtml(value);

  try {
    // No base, so a *document*-relative URL fails here — and that is the point.
    // Anything relative was supposed to have been resolved before it got here, so
    // one that still is, is a file the resolver refused: a picture whose file has
    // gone, or a document naming something outside its own directory.
    const url = new URL(value);
    if (!SAFE_SCHEMES.has(url.protocol)) return null;
  } catch {
    return null;
  }
  return escapeHtml(value);
}

function propString(block: NoteBlock, name: string): string {
  const value = block.props?.[name];
  return typeof value === "string" ? value : "";
}

/** A prop that has to become a number in the markup — a span, a width. Anything
 * else is dropped rather than guessed at. */
function propInt(block: NoteBlock, name: string): number | null {
  const value = block.props?.[name];
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const whole = Math.trunc(value);
  return whole > 0 ? whole : null;
}

/**
 * The text of one inline run, wrapped in whatever its styles say.
 *
 * The order is fixed rather than taken from the object's own key order, so the
 * same run always produces the same markup — `<strong><em>` and `<em><strong>`
 * read identically in a browser and differently in a diff.
 */
const STYLE_TAGS: [string, string][] = [
  ["bold", "strong"],
  ["italic", "em"],
  ["underline", "u"],
  ["strike", "s"],
  ["code", "code"],
];

/**
 * The colours BlockNote's own menu offers, and the only ones this page paints.
 *
 * A colour reaches the page as a **name**, never as the value behind it: the
 * page declares both renderings of each name in its stylesheet and a run gets
 * `var(--hl-yellow-text)`, so a yellow heading is the studio's yellow in light
 * and the studio's other yellow in dark — the same two values BlockNote itself
 * uses, kept in step by the browser rather than by this walk.
 *
 * That is also what makes it safe. Nothing out of the file is ever spent as a
 * CSS value; a name that is not on this list is dropped, which is the whole of
 * the validation.
 *
 * The cost is a colour picked outside the menu — the studio's own `oklch(…)`
 * turns up on table cells this way — which goes. Those are bound to the theme
 * they were picked in, and there is no honest way to show a colour chosen
 * against the editor's dark surface on a page that follows the reader's.
 */
const HIGHLIGHTS = new Set([
  "gray",
  "brown",
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
]);

/**
 * The alignments the editor's own toolbar sets, minus the one that is already
 * the default.
 *
 * `left` is left off on purpose: it is what an unaligned block does anyway, and
 * writing it out would put a `style` on very nearly every element on the page —
 * BlockNote stamps `textAlignment` onto every block it creates, aligned or not.
 * The one place that absence could be read as inheritance is a list nested
 * inside a centred item, and the stylesheet resets that rather than paying for
 * it in the markup.
 */
const ALIGNMENTS = new Set(["center", "right", "justify"]);

/** The alignment a block asked for, or null — a keyword off the list above and
 * never a value out of the file. Its own function because a list item needs the
 * answer as well as the declaration: see `renderListItem`. */
function alignmentOf(
  source: Record<string, unknown> | undefined,
): string | null {
  const value = source?.textAlignment;
  return typeof value === "string" && ALIGNMENTS.has(value) ? value : null;
}

/**
 * The `class` and `style` for whatever the block, run or cell decided about
 * itself — its two colours and its alignment — or "".
 *
 * One function for all three because they are one attribute: an element cannot
 * have two `class`es or two `style`s, and a centred yellow heading is both.
 * Takes the bag rather than the block, because the same names are a run's
 * styles, a block's props and a table cell's props — three places, one rule.
 */
function tint(
  source: Record<string, unknown> | undefined,
  extraClass = "",
): string {
  const classes = extraClass ? [extraClass] : [];
  const declarations: string[] = [];

  if (source) {
    const named = (key: string): string | null => {
      const value = source[key];
      return typeof value === "string" && HIGHLIGHTS.has(value) ? value : null;
    };

    const text = named("textColor");
    const background = named("backgroundColor");
    if (text || background) classes.push("tint");
    if (text) declarations.push(`color:var(--hl-${text}-text)`);
    if (background)
      declarations.push(`background-color:var(--hl-${background}-bg)`);

    const align = alignmentOf(source);
    if (align) declarations.push(`text-align:${align}`);
  }

  return (
    (classes.length ? ` class="${classes.join(" ")}"` : "") +
    (declarations.length ? ` style="${declarations.join(";")}"` : "")
  );
}

function renderStyledText(item: Record<string, unknown>): string {
  const text = typeof item.text === "string" ? item.text : "";
  if (!text) return "";

  const styles = (item.styles ?? {}) as Record<string, unknown>;
  let html = escapeHtml(text);
  for (const [style, tag] of STYLE_TAGS) {
    if (styles[style]) html = `<${tag}>${html}</${tag}>`;
  }

  // Outside the emphasis tags rather than inside: a colour is the run's, and a
  // run that is bold *and* yellow should not have to be two spans deep.
  const colour = tint(styles);
  return colour ? `<span${colour}>${html}</span>` : html;
}

/** A block's inline content: styled runs, links, and whatever an inline content
 * type this build does not know contributes text-wise. */
function renderInline(content: unknown): string {
  if (typeof content === "string") return escapeHtml(content);
  if (!Array.isArray(content)) return "";

  return content
    .map((raw: unknown) => {
      if (typeof raw === "string") return escapeHtml(raw);
      if (typeof raw !== "object" || raw === null) return "";
      const item = raw as Record<string, unknown>;

      if (item.type === "link") {
        const inner = renderInline(item.content);
        const href = safeUrl(item.href);
        // A link whose href was refused keeps its words: dropping the run
        // would take a sentence's text out with a URL nobody can see anyway.
        if (!href) return inner;
        return `<a href="${href}" rel="noreferrer">${inner}</a>`;
      }

      return renderStyledText(item);
    })
    .join("");
}

/** The plain text of a block's content, for the places markup cannot go — an
 * `alt`, a code block's body. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((raw: unknown) => {
      if (typeof raw === "string") return raw;
      if (typeof raw !== "object" || raw === null) return "";
      const item = raw as Record<string, unknown>;
      if (typeof item.text === "string") return item.text;
      return textOf(item.content);
    })
    .join("");
}

/** Which list a block belongs in, or null for anything that is not a list
 * item. The three that share a tag still differ in the class, because a
 * checklist reads as one. */
function listOf(
  block: NoteBlock,
): { tag: "ul" | "ol"; className: string } | null {
  switch (block.type) {
    case "bulletListItem":
      return { tag: "ul", className: "bullets" };
    case "numberedListItem":
      return { tag: "ol", className: "numbers" };
    case "checkListItem":
      return { tag: "ul", className: "checks" };
    case "toggleListItem":
      return { tag: "ul", className: "toggles" };
    default:
      return null;
  }
}

/**
 * A run of blocks.
 *
 * List items arrive as siblings — the document has no list node, only items
 * that happen to follow one another — so consecutive items of the same kind
 * are gathered into one `<ul>` or `<ol>` here. Without it a five-item list is
 * five one-item lists, which is a paragraph of bullets with gaps in a browser
 * and five lists to anything reading the structure.
 */
function renderBlocks(blocks: NoteBlock[], drawings: Drawings): string {
  const html: string[] = [];

  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index];
    if (!block) continue;

    const list = listOf(block);
    if (!list) {
      html.push(renderBlock(block, drawings));
      continue;
    }

    const items: NoteBlock[] = [];
    for (let scan = index; scan < blocks.length; scan++) {
      const candidate = blocks[scan];
      const next = candidate ? listOf(candidate) : null;
      if (!candidate || next?.tag !== list.tag) break;
      if (next.className !== list.className) break;
      items.push(candidate);
      index = scan;
    }

    const first = items[0];
    const start = first ? propInt(first, "start") : null;
    const startAttr =
      list.tag === "ol" && start && start !== 1 ? ` start="${start}"` : "";
    html.push(
      `<${list.tag} class="${list.className}"${startAttr}>` +
        items.map((item) => renderListItem(item, drawings)).join("") +
        `</${list.tag}>`,
    );
  }

  return html.join("\n");
}

/** An item, with anything nested under it inside its own `<li>` — which is
 * where a nested list belongs, and the one place children are not un-nested. */
function renderListItem(block: NoteBlock, drawings: Drawings): string {
  const checked =
    block.type === "checkListItem" ? block.props?.checked === true : null;
  // No space after the box: the gap is the margin the stylesheet gives it, which
  // is the editor's 8px rather than however wide a space is in the reader's font.
  const box =
    checked === null
      ? ""
      : `<input type="checkbox" disabled${checked ? " checked" : ""}>`;

  const children = block.children?.length
    ? renderBlocks(block.children, drawings)
    : "";
  // An aligned item is marked as one so the stylesheet can bring its marker
  // along — a bullet drawn `outside` is anchored to the list's edge and would
  // otherwise sit there alone while its words moved. See `li.aligned`.
  // A ticked one is marked so its words can be struck through as the editor
  // strikes them — and only its words, which is what the span is for: children
  // live inside this `<li>` too, and a decoration reaches them all.
  const classes = [
    alignmentOf(block.props) ? "aligned" : "",
    checked ? "done" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const said = renderInline(block.content);
  const words = checked === null ? said : `<span class="said">${said}</span>`;

  /*
   * A toggle is a disclosure rather than a bullet, and `<details>` is the whole
   * of what that takes: a static page keeps the one behaviour the block is for —
   * opening and closing — with no script, no ids and nothing to restore. It is
   * also the shape BlockNote's own export writes (`<li><details open>`) and the
   * shape its parser reads back, so a note published from here and pasted into
   * an editor is still a toggle rather than a bullet.
   *
   * Closed, as the editor opens one: its state lives in `localStorage` under the
   * block's id and none of it reaches the file, so both views start from the same
   * nothing and have to pick. Shut is what the block is *for* — a note whose
   * toggles all stood open in the preview and shut in the editor was two different
   * documents.
   *
   * Children go in a `.nested` inside the `<details>`, which is what puts them
   * under the disclosure rather than beside it: the fold has to contain them or
   * closing it leaves them on screen.
   */
  if (block.type === "toggleListItem") {
    const fold = children ? `<div class="nested">${children}</div>` : "";
    return `<li${tint(block.props, classes)}><details><summary>${said}</summary>${fold}</details></li>`;
  }

  return `<li${tint(block.props, classes)}>${box}${words}${children}</li>`;
}

/**
 * One block.
 *
 * Children of anything that is not a list item are rendered after it rather
 * than inside it — the same un-nesting BlockNote's own HTML export does, and
 * for the same reason: HTML has no "paragraph with paragraphs under it".
 */
function renderBlock(block: NoteBlock, drawings: Drawings): string {
  /* A tab group spends its children itself — they are its panes, not blocks that
     follow it — so it is taken before the un-nesting below can reach them. */
  if (block.type === "tabList") return renderTabs(block, drawings);

  /* A tab outside a tab group is not a tab. It can be got at by dragging one out
     of its group, or by an edit that wrote one at the top level, and there is no
     strip anywhere that would let a reader open it — so its blocks are drawn as
     the ordinary blocks they are rather than hidden behind a control that does
     not exist. The editor does the same, for the same reason. */
  if (block.type === "tab")
    return block.children?.length ? renderBlocks(block.children, drawings) : "";

  const self = renderBlockSelf(block, drawings);
  if (!block.children?.length) return self;
  return `${self}\n<div class="nested">${renderBlocks(block.children, drawings)}</div>`;
}

/**
 * A tab group, as a page with no script in it can have one.
 *
 * A radio per tab, a label per radio and the pane straight after the radio it
 * belongs to, then `order` in the stylesheet lifts every label above every pane.
 * That ordering is what makes this work without counting anything: the open pane
 * is `input:checked + .tab-panel` and the open label is `label:has(+ input:checked)`,
 * two rules that hold however many tabs a group has. Numbering the panes instead
 * — `nth-of-type` against `nth-of-type` — would have meant a rule per tab and a
 * cap on how many a group may have, and a note that quietly stops showing its
 * ninth tab is worse than no tabs at all.
 *
 * The reader's choice is not carried anywhere. The editor keeps its own in
 * `localStorage` (see `webview/tabs.ts`) and this page keeps its own in the radios
 * until it is closed, which is the same bargain: a note is not rewritten by being
 * read, in either view.
 */
function renderTabs(block: NoteBlock, drawings: Drawings): string {
  const tabs = (block.children ?? []).filter((child) => child.type === "tab");
  // Nothing to open. A group with no tabs is a block that draws nothing rather
  // than an empty box the reader has to wonder about.
  if (tabs.length === 0) return "";

  const group = idOf(block);
  const panes = tabs.map((tab, at) => {
    const id = `${group}-${at}`;
    // The first, because a page arriving with no tab open would be a group whose
    // content is all hidden until somebody guesses to click it.
    const checked = at === 0 ? " checked" : "";
    const inside = tab.children?.length
      ? renderBlocks(tab.children, drawings)
      : "";
    return (
      `<label for="${id}">${escapeHtml(titleOf(tab, at))}</label>` +
      `<input type="radio" name="${group}" id="${id}"${checked}>` +
      `<div class="tab-panel">${inside}</div>`
    );
  });

  return `<div class="tabs">${panes.join("")}</div>`;
}

/** A tab with no name of its own is still a tab somebody has to be able to click,
 * so it is named by where it sits — the editor's own fallback. */
function titleOf(tab: NoteBlock, at: number): string {
  const title = tab.props?.title;
  return typeof title === "string" && title.trim() ? title : `Tab ${at + 1}`;
}

/**
 * An `id` for a block, safe to spend as one.
 *
 * A note's ids are BlockNote's, which are uuids, but a note is a file and a file
 * can hold anything — so what reaches an `id=` and a `for=` here is only the
 * characters those may hold, and a block with no usable id at all gets a number
 * instead. The counter is not reset between notes on purpose: nothing needs these
 * to be the same twice, only to be different from each other on one page.
 */
let anonymous = 0;

function idOf(block: NoteBlock): string {
  const cleaned = String(block.id ?? "").replace(/[^A-Za-z0-9_-]/g, "");
  return `tabs-${cleaned || `x${(anonymous += 1)}`}`;
}

function renderBlockSelf(block: NoteBlock, drawings: Drawings): string {
  switch (block.type) {
    case "heading": {
      const level = Math.min(
        Math.max(propInt(block, "level") ?? 1, 1),
        MAX_HEADING,
      );
      return `<h${level}${tint(block.props)}>${renderInline(
        block.content,
      )}</h${level}>`;
    }

    case "quote":
      return `<blockquote${tint(block.props)}>${renderInline(
        block.content,
      )}</blockquote>`;

    case "divider":
      return "<hr>";

    case "codeBlock": {
      // The language becomes a class name, so it is spent as one: a highlighter
      // reads `language-ts`, and anything that is not a plain identifier is not
      // a language.
      const language = propString(block, "language");
      const className = /^[a-z0-9+#_-]{1,24}$/i.test(language)
        ? ` class="language-${language}"`
        : "";
      return `<pre><code${className}>${escapeHtml(textOf(block.content))}</code></pre>`;
    }

    case "table":
      return renderTable(block);

    case "image":
      return renderImage(block);

    case "video":
      return renderMedia(block, "video");

    case "audio":
      return renderMedia(block, "audio");

    case "file":
      return renderFile(block);

    case "drawing":
      return renderDrawing(block, drawings);

    case "paragraph":
      return `<p${tint(block.props)}>${renderInline(block.content)}</p>`;

    default: {
      // A block this build has no case for — one a later version of the studio
      // wrote, or a custom one. Its words are still the note's words, so they
      // are shown; the type rides along in an attribute for whoever is looking
      // at why it came out plain.
      const inline = renderInline(block.content);
      if (!inline) return "";
      const type = escapeHtml(block.type ?? "block");
      return `<p data-block-type="${type}">${inline}</p>`;
    }
  }
}

function renderTable(block: NoteBlock): string {
  const content = block.content as
    | {
        rows?: { cells?: unknown }[];
        headerRows?: number;
        columnWidths?: unknown;
      }
    | undefined;
  const rows = Array.isArray(content?.rows) ? content.rows : [];
  if (rows.length === 0) return "";

  const headerRows =
    typeof content?.headerRows === "number"
      ? Math.max(0, content.headerRows)
      : 0;

  const rendered = rows.map((row, index) => {
    const cells = Array.isArray(row.cells) ? row.cells : [];
    const tag = index < headerRows ? "th" : "td";
    const html = cells
      .map((raw: unknown) => {
        // Two shapes, both of them BlockNote's: a cell is either the object
        // with props or the inline content on its own.
        const cell =
          typeof raw === "object" && raw !== null && "type" in raw
            ? (raw as { content?: unknown; props?: Record<string, unknown> })
            : { content: raw, props: undefined };

        const span = (name: string): string => {
          const value = cell.props?.[name];
          return typeof value === "number" && value > 1
            ? ` ${name}="${Math.trunc(value)}"`
            : "";
        };

        return `<${tag}${span("colspan")}${span("rowspan")}${tint(
          cell.props,
        )}>${renderInline(cell.content)}</${tag}>`;
      })
      .join("");
    return `<tr>${html}</tr>`;
  });

  const head =
    headerRows > 0
      ? `<thead>${rendered.slice(0, headerRows).join("")}</thead>`
      : "";
  const body = `<tbody>${rendered.slice(headerRows).join("")}</tbody>`;
  const { colgroup, style } = columns(content?.columnWidths);
  // Wrapped, because a table with eight columns in a note is wider than the
  // measure the page is set to and has to scroll in its own box rather than
  // taking the page sideways with it.
  return `<div class="scroller"><table${
    colgroup ? ` class="sized"` : ""
  }${style}>${colgroup}${head}${body}</table></div>`;
}

/**
 * The table's own column widths, as the `<colgroup>` the editor keeps them in.
 *
 * A width in a note is a real decision — the two narrow columns at the left of
 * a spec table are what make the wide one at the right readable — so it travels
 * with the table rather than being left for the browser to guess at from the
 * content, which is what dropping the colgroup meant.
 *
 * `table-layout: fixed` comes with it (the `sized` class), because that is what
 * makes a width a width: under the automatic layout a browser treats one as a
 * suggestion and stretches it to fit the content, which is the same table the
 * colgroup was there to prevent. It is the layout the editor itself uses.
 *
 * The two widths are spent differently. With every column sized, the table is
 * exactly as wide as they add up to and sits at the left — the editor's own
 * `width: auto`, and a four-column table does not get stretched across a page
 * far wider than the pane it was built in. With any column unsized, the table
 * fills the measure and the sized ones keep their pixels while the rest share
 * what is left, which is the arrangement that mixed table was drawn in.
 *
 * Nothing here can carry a value out of the file: a width is a finite positive
 * number rounded to an integer, or the column is left for the layout to size.
 */
function columns(widths: unknown): { colgroup: string; style: string } {
  if (!Array.isArray(widths)) return { colgroup: "", style: "" };

  const sizes = widths.map((width: unknown) =>
    typeof width === "number" && Number.isFinite(width) && width > 0
      ? Math.round(width)
      : null,
  );
  if (!sizes.some((size) => size !== null)) return { colgroup: "", style: "" };

  const colgroup = `<colgroup>${sizes
    .map((size) => (size === null ? "<col>" : `<col style="width:${size}px">`))
    .join("")}</colgroup>`;

  const total = sizes.reduce((sum: number, size) => sum + (size ?? 0), 0);
  const style = sizes.every((size) => size !== null)
    ? ` style="width:${total}px"`
    : "";

  return { colgroup, style };
}

function renderImage(block: NoteBlock): string {
  const src = safeUrl(block.props?.url);
  const caption = propString(block, "caption");
  const name = propString(block, "name");
  if (!src)
    return caption ? `<p class="missing">${escapeHtml(caption)}</p>` : "";

  const width = propInt(block, "previewWidth");
  const figcaption = caption
    ? `<figcaption>${escapeHtml(caption)}</figcaption>`
    : "";
  // The alignment goes on the figure rather than the picture: an `<img>` is an
  // inline box, so `text-align` on the thing around it is what moves it — and
  // it carries the caption along with it, which is where a caption belongs.
  return (
    `<figure${tint(block.props)}><img src="${src}" alt="${escapeHtml(
      caption || name,
    )}"` + `${width ? ` width="${width}"` : ""}>${figcaption}</figure>`
  );
}

/**
 * A video or an audio clip, as the control the browser already has.
 *
 * A player rather than the link this used to be, because the note is being read
 * here: a clip explaining a bug is the note's content in the way a screenshot
 * is, and "open this in a new tab" is a worse answer than a play button. What
 * makes it possible is the file being served on a URL of its own
 * (`preview.ts`'s file route) — a `data:` URL cannot be seeked within, so this
 * is the one thing on the page that is not inlined.
 *
 * `preload="metadata"` and no `autoplay`: a note with three clips in it should
 * cost three headers rather than three downloads, and nothing on a page someone
 * opened to read should start making noise. A block the editor was told not to
 * preview, and one whose file cannot be reached, both fall back to what
 * `renderFile` does — the name, as a link or as the note saying it is gone.
 */
function renderMedia(block: NoteBlock, tag: "video" | "audio"): string {
  const src = safeUrl(block.props?.url);
  if (!src || block.props?.showPreview === false) return renderFile(block);

  const caption = propString(block, "caption");
  const figcaption = caption
    ? `<figcaption>${escapeHtml(caption)}</figcaption>`
    : "";
  return (
    `<figure${tint(block.props, "media")}>` +
    `<${tag} controls preload="metadata" src="${src}">` +
    `</${tag}>${figcaption}</figure>`
  );
}

/** An attachment: a link rather than a control, since a browser has nothing to
 * play a `.zip` with. The file is wherever the note said it was, and a preview
 * page that cannot reach it says what it was rather than showing a control that
 * does nothing. */
function renderFile(block: NoteBlock): string {
  const href = safeUrl(block.props?.url);
  const label =
    propString(block, "name") || propString(block, "caption") || block.type;
  if (!href) return `<p class="missing">${escapeHtml(label ?? "")}</p>`;
  return `<p${tint(block.props, "file")}><a href="${href}" rel="noreferrer">${escapeHtml(
    label ?? "",
  )}</a></p>`;
}

/**
 * A drawing, as the picture the studio last exported for it.
 *
 * The SVG is inlined rather than linked so the page is one request and one
 * file — which is what makes it something that can be saved, mailed, or handed
 * to a reader that follows no links. A drawing with no export yet says so
 * instead of leaving a gap: it is a scene this app has not opened since the
 * export was added, and a blank space would read as a note with nothing there.
 */
function renderDrawing(block: NoteBlock, drawings: Drawings): string {
  const id = propString(block, "drawingId");
  const svg = id ? drawings.get(id) : undefined;
  if (svg) return `<figure${tint(block.props, "drawing")}>${svg}</figure>`;
  // The scene is a file and this page cannot run Excalidraw, so what it shows is
  // the picture exported beside the scene when the drawing was last saved. One
  // that has never been saved — or was written by a build that exported nothing —
  // says so rather than leaving a gap.
  return `<figure class="drawing"><p class="missing">Drawing — open it once and save to export a picture of it</p></figure>`;
}

/** The note itself, as the `<article>` a page wraps around. */
export function renderNote(blocks: NoteBlock[], drawings: Drawings): string {
  return renderBlocks(blocks, drawings);
}

/**
 * Every token the dark palette moves, as declarations rather than a rule.
 *
 * A string because the stylesheet needs this twice under two different guards
 * (see `page`), and a palette that is only correct while two copies of it agree
 * is a palette that will stop being correct. Nothing in it is a selector, so it
 * is spent inside whichever one the page is emitting.
 */
const DARK = `
    /* VS Code's Dark Modern, which is the editor's own dark theme and the one the
       preview is most often opened beside: \`editor.background\` #1f1f1f under
       \`editor.foreground\` #cccccc. It used to be a near-black #0a0a0a on a warmer
       grey, which read as a different application in the tab next door.

       Written out rather than taken from \`--vscode-*\`, and that is not laziness.
       This page is also served to a browser, which has no such variables — but the
       reason it is not *conditional* on them is \`togglePreviewTheme\`: a reader can
       pin the preview light while the editor is dark, and a palette that read the
       editor's colours would quietly ignore them. A pinned theme has to be the
       theme.

       \`--sunk\` is lighter than the paper rather than darker, because on a dark
       surface there is no darker left to go; \`--line\` is a hairline that has to be
       seen against #1f1f1f, which #27272a was not. \`--link\` and \`--code\` are
       unchanged: they are the two blues on this page and they have to stay apart
       from each other — see the \`code\` rule below. */
    --ink: #cccccc; --dim: #9d9d9d; --line: #333333; --sunk: #262626; --paper: #1f1f1f; --link: #a5b4fc; --code: #3794ff;
    --hl-gray-text: #bebdb8; --hl-gray-bg: #9b9a97;
    --hl-brown-text: #8e6552; --hl-brown-bg: #64473a;
    --hl-red-text: #ec4040; --hl-red-bg: #be3434;
    --hl-orange-text: #e3790d; --hl-orange-bg: #b7600a;
    --hl-yellow-text: #dfab01; --hl-yellow-bg: #b58b00;
    --hl-green-text: #6b8b87; --hl-green-bg: #4d6461;
    --hl-blue-text: #0e87bc; --hl-blue-bg: #0b6e99;
    --hl-purple-text: #8552d7; --hl-purple-bg: #6940a5;
    --hl-pink-text: #da208f; --hl-pink-bg: #ad1a72;
  `;

/**
 * The page around it.
 *
 * One stylesheet, inline, because a preview is one file: nothing to fetch, no
 * second request to fail, and a page that can be saved out of the browser and
 * still look like itself.
 *
 * **Light and dark are one stylesheet too**, selected by `data-theme` on the
 * `<html>` element with `auto` — the surface's own light/dark — as the default.
 * The attribute rather than a class or a second stylesheet because it is the one
 * hook both readers of this page can turn: the extension re-renders with it set
 * when the toggle command runs, and the served page's own script writes it from
 * `localStorage` before the first paint. Nothing below reads the attribute
 * except the three rules at the top of the palette, so a page rendered `auto`
 * and one rendered `light` differ by four characters.
 *
 * **The reload poll is the one thing dropped on the way here.** In the app this
 * page is served over a socket to a real browser, which has no channel to be
 * told the note changed, so the page polled its own URL with `HEAD` and compared
 * an ETag. A webview is pushed instead — `preview.ts` redraws it from
 * `onDidChangeTextDocument` — so the poll would be a fetch of a
 * `vscode-resource` URL that answers no ETag, on a page whose CSP forbids
 * scripts in the first place. `version` stays because it costs nothing and is
 * what would be compared again if this ever went back to being served.
 */
export function page(
  title: string,
  version: string,
  body: string,
  theme: PreviewTheme = "auto",
): string {
  // Spent as an attribute value, so it is a keyword off the list or it is the
  // default — the same rule every other value out of the outside world gets on
  // this page.
  const chosen = THEMES.has(theme) ? theme : "auto";
  return `<!doctype html>
<html lang="en" data-theme="${chosen}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="version" content="${escapeHtml(version)}">
<title>${escapeHtml(title)}</title>
<style>
/* The light palette, which is also the one a page with no opinion starts from:
   \`color-scheme\` is left at both so the *surface* decides, and the two rules
   under it are the whole of what \`data-theme\` does — pinning that decision, which
   is what makes the browser paint its own form controls and scrollbars to match
   a theme the page chose rather than one it inherited. */
:root { color-scheme: light dark; --ink: #18181b; --dim: #71717a; --line: #e4e4e7; --sunk: #f4f4f5; --paper: #ffffff; --link: #4338ca; --code: #0b6e99; }
:root[data-theme="light"] { color-scheme: light; }
:root[data-theme="dark"] { color-scheme: dark; }
/* BlockNote's own palette, both renderings of it, so a colour picked in the
   editor is that colour here and still legible on whichever surface the
   reader's browser paints. Only names reach the markup — see \`tint\`. */
:root {
  --hl-gray-text: #9b9a97; --hl-gray-bg: #ebeced;
  --hl-brown-text: #64473a; --hl-brown-bg: #e9e5e3;
  --hl-red-text: #e03e3e; --hl-red-bg: #fbe4e4;
  --hl-orange-text: #d9730d; --hl-orange-bg: #f6e9d9;
  /* Darker than BlockNote's own #dfab01, which is a yellow chosen to sit on the
     editor's dark surface and all but disappears on this page's white one. */
  --hl-yellow-text: #b08a01; --hl-yellow-bg: #fbf3db;
  --hl-green-text: #4d6461; --hl-green-bg: #ddedea;
  --hl-blue-text: #0b6e99; --hl-blue-bg: #ddebf1;
  --hl-purple-text: #6940a5; --hl-purple-bg: #eae4f2;
  --hl-pink-text: #ad1a72; --hl-pink-bg: #f4dfeb;
}
/* The dark palette, in the three ways a page arrives at it, written once in
   \`DARK\` above and emitted twice — the guard differs, the colours must not.

   The media query is the surface asking, and it is skipped by a page that was
   rendered \`light\`: an explicit choice outranks the reader's OS, which is the
   only reason to have made one. \`body.vscode-dark\` is the same question asked
   the way VS Code answers it — the class it stamps on a webview's body — so the
   preview beside the editor follows the editor's theme even where the webview's
   \`prefers-color-scheme\` does not. */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { ${DARK} }
}
:root[data-theme="dark"],
:root:not([data-theme="light"]) body.vscode-dark { ${DARK} }
* { box-sizing: border-box; }
/* The note's type scale. Its twin, and the reasoning behind choosing a document's
   scale over the editor's UI one, is at the top of \`src/webview/theme.css\`; these
   two stylesheets cannot be one file and are only correct while they agree. */
body { margin: 0; background: var(--paper); color: var(--ink); font: 16px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
/*
 * The gaps and the indent, which are the editor's numbers and not a browser's.
 *
 * **Why they are tokens now.** Every block in the editor carries
 * \`--note-block-space\` of padding above and below it, and padding does not
 * collapse — so the space between two blocks there is *twice* it, and the air
 * around a heading is the heading's own margin *plus* that. This page was written
 * with the browser's collapsing margins instead, where the same two blocks share
 * one gap: every list, every heading and every quote sat tighter here than the same
 * note did in the editor, by 6 to 12 pixels each.
 *
 * So what is copied below is the editor's *model* rather than an approximation of
 * its results: a block spends the space as padding, and a block that draws a box of
 * its own — a quote, a code block, a figure, a table — spends it as margin instead,
 * because its padding is already the inside of that box. What makes the two
 * interchangeable is \`article\` being a flex column: margins do not collapse between
 * flex items, so 6 and 6 are 12 either way, and a quote after a heading keeps its
 * own space instead of losing it inside the heading's larger margin.
 *
 * \`--indent\` is BlockNote's own 24px: the width of the lane a bullet or a number is
 * drawn in (\`min-width: 24px\`), and the step a nested list moves by
 * (\`.bn-block-group .bn-block-group { margin-left: 24px }\`).
 *
 * Keep in step with \`src/webview/theme.css\`.
 */
:root { --block-space: 0.125rem; --heading-space: 1rem; --heading-space-after: 0.25rem; --indent: 24px; }
/* A note holds URLs, ids and paths — one unbroken string longer than the
   measure — and a page that cannot break one is a page scrolling sideways with
   its own text off the edge. \`anywhere\` rather than \`break-word\`: it counts
   towards a table cell's min-content width too, which is what stops one long
   link from making the whole table wider than the screen. Not on \`pre\`, which
   scrolls instead: a line break invented inside code is a lie about the code. */
p, li, td, th, h1, h2, h3, h4, h5, h6, blockquote, figcaption, a { overflow-wrap: anywhere; }
/* The measure and the inset are the editor's — see the type scale note in
   \`webview/theme.css\`, which every number from here down has a twin in. 78rem
   rather than the 76 this page used: a note is read as prose either way, and this
   is the copy that gets opened maximised in a browser.

   \`content-box\`, against the \`border-box\` everything else on this page is in,
   because the editor's measure is on the box *inside* its padding (\`.bn-editor >
   .bn-block-group\`) while this one is on the box that carries it. Left as
   \`border-box\` the same note is read at 78rem in the editor and at 78rem minus two
   insets here — up to 7rem narrower, which is a different line break in every
   paragraph. */
main { box-sizing: content-box; max-width: 78rem; margin: 0 auto; padding: 1.5rem clamp(1.5rem, 4%, 3.5rem) 6rem; }
/* The one thing that keeps the spacing above honest: between flex items margins do
   not collapse, so every block's 6px counts and the sums are the editor's. A list
   item cannot join in — a flex \`<li>\` draws no marker at all — and does not need to,
   since an item spends its space as padding. */
article, .nested { display: flex; flex-direction: column; }
/* Except here, which is the one collapse the editor does have: two headings in a row
   share the larger margin rather than adding both, because there they are ordinary
   block boxes in a block container. Without this the gap between an h2 and the h3
   under it would be 8px wider here than in the editor. */
:is(h1, h2, h3, h4, h5, h6) + :is(h1, h2, h3, h4, h5, h6) { margin-top: calc(var(--heading-space) - var(--heading-space-after)); }
/* The note's own heading scale, spelled out rather than left to the browser's:
   its 2 / 1.5 / 1.17 / 1 / .83 / .67 crossed the editor's at h3, so an h1 was
   smaller here and an h3 larger. Both ends use these now. */
h1, h2, h3, h4, h5, h6 { line-height: 1.3; margin: var(--heading-space) 0 var(--heading-space-after); padding: var(--block-space) 0; font-weight: 600; }
/* The air above, per level, spent as a variable rather than as a \`margin-top\` —
   because the rule two lines down subtracts from it, and a heading that had
   overridden the margin directly would have taken its own value out of that sum.
   Set here, both rules read the level's own number. Twin: \`--note-heading-space-1\`
   in \`theme.css\`, in \`rem\` for the reason written there. */
h1 { font-size: 1.875em; --heading-space: 2rem; }
h2 { font-size: 1.5em; --heading-space: 1.4rem; }
h3 { font-size: 1.25em; }
h4 { font-size: 1.1em; }
h5 { font-size: 1em; }
h6 { font-size: 0.9em; }
/* Nothing above the note's first heading: the page's top padding is that space. */
article > h1:first-child, article > h2:first-child, article > h3:first-child { margin-top: 0; }
p { margin: 0; padding: var(--block-space) 0; }
a { color: var(--link); }
/* The editor's divider is a rule with \`0.5em\` of its own above and below *inside*
   a block that already carries its padding, and this is that sum. */
hr { border: 0; border-top: 1px solid var(--line); margin: calc(var(--block-space) + 0.5em) 0; }
/* \`currentColor\` rather than \`--line\`, which is the hairline a table is drawn
   with: at #e4e4e7 on white it is a rule nobody sees, and a quote with an
   invisible bar is a paragraph that has mysteriously gone grey. The bar and the
   words being the one colour is also what the editor shows — BlockNote gives
   both #7d797a — so the two views agree.

   Padding on all four sides, not just the left. A quote is the one block that is
   commonly given a background as well, and the old \`0.25rem 0\` painted that
   background as a full-bleed band with the sentence jammed against its top and
   right edges. The margin absorbs the extra height so an untinted quote sits
   where it did. */
blockquote { margin: var(--block-space) 0; padding: 0.5rem 0.9rem; border-left: 3px solid currentColor; color: var(--dim); border-radius: 0 0.25rem 0.25rem 0; }
/* Inline code is a colour rather than a chip — the editor's rule, in this page's
   tokens. \`--code\` is a blue of its own and not \`--link\`: the two would be the
   same weight of the same hue, and a reader would try clicking the code.

   The three zeroes are for the webview this page is also shown in: VS Code's own
   stylesheet draws a chip on the bare \`code\` selector, and a rule that only sets
   a colour leaves that chip standing. In a browser they undo nothing. */
code { color: var(--code); background: none; padding: 0; border-radius: 0; font-family: ui-monospace, SFMono-Regular, monospace; font-size: 0.875em; }
pre { background: var(--sunk); border: 1px solid var(--line); border-radius: 0.5rem; margin: var(--block-space) 0; padding: 1rem; overflow-x: auto; }
/* A code *block* keeps its box and its ink: the selector above is bare \`code\`,
   which is every \`<code>\` on the page including the one inside each \`<pre>\`. */
pre code { color: var(--ink); font-size: 0.85rem; }
/*
 * A tab group, switched by radios the reader never sees.
 *
 * The markup is label, radio, pane, repeated — every pane directly after the radio
 * that opens it — and \`order\` is what turns that into a strip with one pane under
 * it. Two rules then do all the switching, and neither of them counts tabs: the
 * open pane is the one whose radio is checked, and the open label is the one
 * immediately before that radio. See \`renderTabs\`.
 */
.tabs { display: flex; flex-wrap: wrap; align-items: center; margin: var(--block-space) 0; }
/* Never drawn — the label is what a reader clicks — but not \`display: none\` on
   the radio itself, which in some engines takes it out of the tab order and off
   the keyboard with it. Arrow keys move between the tabs of a group, which is what
   a radio group already does and what a scripted tab strip has to be taught. */
.tabs > input { position: absolute; width: 0; height: 0; opacity: 0; }
.tabs > label { order: 1; border-radius: 4px; padding: 3px 10px; color: var(--dim); font-size: 0.875em; line-height: 1.4; cursor: pointer; user-select: none; }
.tabs > label:hover { background: var(--sunk); }
/* Weight as well as colour: a strip that marked the open tab by colour alone is
   one nobody reading in high contrast — or in print — can use. */
.tabs > label:has(+ input:checked) { background: var(--sunk); color: var(--ink); font-weight: 600; }
/* The keyboard's own outline, on the label, since the radio it belongs to has no
   box to draw one around. */
.tabs > label:has(+ input:focus-visible) { outline: 2px solid var(--link); outline-offset: 1px; }
/* \`flex\` rather than \`block\` when it opens, because a pane holds blocks and the
   spacing model above is a flex column — see \`article, .nested\`.

   Two borders, meeting at the corner: the top one is the strip's underline, drawn
   on the pane so that a group with its first tab open looks the same as one with
   its last, and the left one is the rail that says these blocks belong to a tab.
   Which tab is open is answered at the top of the group and nowhere else, and a
   pane can be long enough to scroll that answer away. Both are the editor's, in
   this page's tokens — see \`.bn-block-group\` under a \`tab\` in \`theme.css\`. */
.tabs > .tab-panel { order: 2; flex-basis: 100%; display: none; }
.tabs > input:checked + .tab-panel { display: flex; flex-direction: column; border-top: 1px solid var(--line); border-left: 1px solid var(--line); padding: 0 0 0 16px; margin-top: 4px; }
/* A list carries no space of its own: its items are blocks in the editor and each
   one brings its own, so a list that also had a margin would open with a gap the
   editor does not have. The indent is the marker's lane — see \`--indent\`. */
ul, ol { margin: 0; padding: 0 0 0 var(--indent); }
li { margin: 0; padding: var(--block-space) 0; }
/* A nested list is inside its parent's \`<li>\`, so the parent's own padding-bottom
   would fall *below* the whole sublist rather than under the line it belongs to:
   the top is added back here and the bottom given to the last child instead. Both
   ends of the sublist then sit 12px from their neighbours, which is what the
   editor's separate block group does. */
li > ul, li > ol, li > details > .nested { padding-top: var(--block-space); }
li:has(> ul), li:has(> ol), li:has(> .nested),
/* Only while it is open. A shut toggle shows nothing below its own line, so the
   padding this rule removes is padding it still needs — without \`[open]\` every
   closed toggle sits hard against whatever follows it. */
li:has(> details[open] > .nested) { padding-bottom: 0; }
/* The bullets are the glyphs the editor draws — BlockNote writes them as text
   (\`content: "•"\`) rather than as a list marker, and a browser's own \`disc\` and
   \`circle\` are a different weight and a different size at the same font. Depth
   picks the glyph the same way it does there.

   The two spaces are the lane. A marker a stylesheet writes gets none of the gap a
   browser leaves after one it drew itself, so \`•\` ends up against the first letter;
   there the glyph is centred in a 24px column with 4px after it, and a marker box
   two spaces wider is the same glyph in the same place. Non-breaking, or the marker
   would be trimmed back to the bullet. */
ul.bullets > li::marker { content: "•\\a0\\a0"; }
ul.bullets ul.bullets > li::marker { content: "◦\\a0\\a0"; }
ul.bullets ul.bullets ul.bullets > li::marker { content: "▪︎\\a0\\a0"; }
/* A checklist's marker is the box itself, so the lane is spent on the input rather
   than on the list: 4px in front of it and 8px after, which is where the editor
   puts the same 12px box (\`.bn-block-content[data-content-type=checkListItem] >
   div > input\`). The two together with the box come to \`--indent\`, so a checklist
   and a bulleted list start their words in the same column. */
ul.checks { list-style: none; padding: 0 0 0 4px; }
ul.checks input { margin: 0 8px 0 0; }
/* A toggle's marker is its own chevron, so the list gives up its bullet and the
   lane is spent inside the \`<summary>\` — the checklist's arrangement exactly,
   4px in front and 8px after a 12px glyph, which comes to \`--indent\`. A toggle,
   a checklist and a bulleted list all start their words in the same column.

   Two markers have to be turned off, not one: \`list-style\` for the \`<li>\` and
   for \`<summary>\`, which is itself a list item in every engine, plus WebKit's
   own pseudo-element for the same triangle. */
ul.toggles { list-style: none; padding: 0 0 0 4px; }
ul.toggles summary { list-style: none; cursor: pointer; }
ul.toggles summary::-webkit-details-marker { display: none; }
/* The editor's triangle, redrawn rather than fetched.

   BlockNote's is Material's \`play_arrow\` written into the button as inline SVG —
   markup, not a url, so there is nothing this page could link to even if its CSP
   let it. What it draws is a plain triangle, and the borders of an empty box are
   a plain triangle: at the editor's 18px icon that path measures 8.25 by 10.5,
   which is the 8 by 10 below to within a quarter of a pixel and renders crisper
   for being whole ones.

   The lane is the editor's too. There the 24px button holds the triangle and the
   words start after it; here 4px of list padding, 5 before the triangle and 7
   after come to the same 24, with the same slight rightward bias the icon has
   inside its own box — so a toggle, a checklist and a bulleted list all start
   their words in the same column, and the mark sits where the editor puts it.

   \`inline-block\` is what makes it turnable at all — a transform does nothing to
   an inline box — and \`middle\` keeps it in the line rather than on the baseline,
   which for a box this small is under the words. The 90° is BlockNote's own, on
   the wrapper rather than the mark, and instant there as it is here. */
ul.toggles summary::before { content: ""; display: inline-block; width: 0; height: 0; margin: 0 7px 0 5px; vertical-align: middle; border-left: 8px solid currentColor; border-top: 5px solid transparent; border-bottom: 5px solid transparent; color: var(--ink); }
ul.toggles details[open] > summary::before { transform: rotate(90deg); }
/* A done item is struck through, as it is in the editor. Only its own words: the
   span is there because a decoration on the \`<li>\` would run through anything
   nested under it too, and \`text-decoration\` cannot be turned off by a
   descendant. */
li.done > .said { text-decoration: line-through; }
/* Anything nested under a list item lives *inside* its \`<li>\` — the one place
   in this document children are not un-nested — so a centred item would hand
   its alignment down to everything beneath it. \`text-align\` is inherited, and
   only a block that chose an alignment writes one (see \`ALIGNMENTS\`), so
   without this a child's silence would read as its parent's decision. Each of
   these still overrides it inline when it has an alignment of its own. */
li > ul, li > ol, li > p, li > blockquote, li > pre, li > figure,
li > .nested, li > .scroller, li > details > .nested { text-align: initial; }
/* An aligned item takes its marker with it. A bullet or a number drawn
   \`outside\` is anchored to the list's own edge, so aligning the words alone
   leaves the marker behind with a lane of white between it and the sentence it
   belongs to. That is not what the editor shows either: there an item is a flex
   row of marker-then-content and the alignment moves the whole row (BlockNote's
   \`justify-content\` on \`.bn-block-content\`). \`inside\` puts the marker in the
   line box, which is the same row with the markers a browser already draws.
   Only the aligned items, because \`outside\` is the better default: it is what
   hangs a wrapped line under the first word rather than under the bullet. */
li.aligned { list-style-position: inside; }
.nested { margin-left: var(--indent); }
.scroller { overflow-x: auto; margin: var(--block-space) 0; }
/* \`word-break\` is the editor's own — BlockNote sets it on every table it draws.
   It is here because under the automatic layout a browser sizes a column from the
   longest thing that cannot be broken, so a table whose cells break differently in
   the two views is a table whose *columns* come out different widths. */
table { border-collapse: collapse; width: 100%; font-size: 0.9rem; word-break: break-word; }
/* Only a table whose note carries column widths — see \`columns\`. Fixed layout
   on a table with no widths at all would divide it into equal columns, which is
   worse than what the content itself suggests. */
table.sized { table-layout: fixed; }
/* The floor the editor puts under an unsized column, which is the last thing the
   two disagreed about.
 *
 * ProseMirror's table view writes \`--default-cell-min-width: 120px\` onto every
 * table as an inline style, and BlockNote spends it as
 * \`td:not([data-colwidth]) { min-width: … !important }\` — so in the editor no
 * column nobody has sized is ever narrower than 120px, and a table with more
 * columns than fit stops shrinking and scrolls instead. Without the same floor here
 * the automatic layout squeezed the same table into the measure, and every column
 * came out a different width from the one beside the editor.
 *
 * \`:not(.sized)\` because that is exactly the case: with no widths in the note every
 * column is unsized, which is every cell. A table where *some* column carries a
 * width is left alone — the editor floors the unsized ones there too, but which
 * cells those are is a column number, and reaching a column by number from CSS
 * means a rule per column and a cap on how many a table may have. */
table:not(.sized) th, table:not(.sized) td { min-width: 120px; }
th, td { border: 1px solid var(--line); padding: 0.4rem 0.6rem; text-align: left; vertical-align: top; }
thead th { background: var(--sunk); }
figure { margin: var(--block-space) 0; }
figure img, figure svg { max-width: 100%; height: auto; }
/* A player is a control rather than a picture, so it takes the measure it is
   given instead of its own intrinsic size — a phone clip would otherwise be
   drawn 320px wide in the middle of the page. The video's own box is dark
   whatever the theme, because that is what letterboxing looks like. */
.media video { width: 100%; max-height: 32rem; background: #000; border-radius: 0.5rem; }
.media audio { width: 100%; }
figcaption { color: var(--dim); font-size: 0.85rem; margin-top: 0.4rem; }
/* White in both themes, on purpose: the SVG inside was exported from a scene
   drawn on Excalidraw's own white canvas, so its strokes are dark ink and a card
   that followed the page into dark would be a diagram nobody can see. */
.drawing { border: 1px solid var(--line); border-radius: 0.5rem; padding: 0.75rem; background: #ffffff; }
.missing { color: var(--dim); font-size: 0.85rem; text-align: center; margin: 0; }
.markdown { white-space: pre-wrap; overflow-wrap: anywhere; }
/* A run the note gave a colour to. The radius is for the background: a
   highlight with square ends reads as a table cell rather than a marker. */
.tint { border-radius: 0.2em; }
.index { list-style: none; padding: 0; }
.index li { margin: 0.4rem 0; }
.index .where { color: var(--dim); font-size: 0.8rem; }
</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
}

/**
 * A note an older build left as markdown.
 *
 * Shown as itself rather than rendered. Turning markdown into blocks needs
 * BlockNote's parser, which needs the editor, which is the renderer — and the
 * conversion happens the first time the note is opened in the studio anyway,
 * so this is what a note nobody has opened since the migration looks like.
 * Markdown in a `<pre>` is still the whole note, in an order a reader can
 * follow.
 */
export function renderMarkdown(text: string): string {
  return `<pre class="markdown">${escapeHtml(text)}</pre>`;
}
