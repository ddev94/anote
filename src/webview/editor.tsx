import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react"
import {
  BlockNoteSchema,
  defaultBlockSpecs,
  defaultStyleSpecs,
  filterSuggestionItems,
} from "@blocknote/core"
import {
  BasicTextStyleButton,
  DragHandleMenu,
  FormattingToolbar,
  FormattingToolbarController,
  RemoveBlockItem,
  SideMenu,
  SideMenuController,
  SuggestionMenuController,
  TableRowHeaderItem,
  getDefaultReactSlashMenuItems,
  getFormattingToolbarItems,
  useCreateBlockNote,
  useDictionary,
} from "@blocknote/react"
import { BlockNoteView } from "@blocknote/mantine"

import {
  EDITOR_BLOCK_TYPES,
  foldUnsupported,
  unfoldUnsupported,
  UNSUPPORTED_BLOCK,
} from "../note-schema"
import type { NoteBlock, NoteFormat } from "../protocol"
import { base64Of, upload } from "./bridge"
import { DRAWING_BLOCK, drawingBlockSpec } from "./drawing-block"
import {
  newTabs,
  TAB_BLOCK,
  TAB_LIST_BLOCK,
  tabBlockSpec,
  tabListBlockSpec,
} from "./tabs-block"
import { DrawingEditor } from "./drawing-editor"
import { newDrawingId, onDrawingOpened, openDrawing } from "./drawings"
import { unsupportedBlockSpec } from "./unsupported"

/**
 * The note, as blocks.
 *
 * A near-copy of the app's `components/studio/note/block-editor.tsx`, and the two
 * differences are the two things a webview changes:
 *
 * 1. **`uploadFile` writes through the host.** A webview cannot touch the disk, so
 *    a dropped picture is read to base64, sent over, and comes back as a path
 *    relative to the note.
 * 2. **`resolveFileUrl` turns that path into something loadable.** The app needs
 *    no such hook because it registers a `note-file://` scheme that Chromium
 *    fetches directly; here the only URL a webview may load is one
 *    `asWebviewUri` produced, and BlockNote has exactly this hook for the case.
 *
 * The `mantine` view rather than the app's `shadcn` one: that build is a vendored
 * set of shadcn components styled with Tailwind classes, so it needs a Tailwind
 * build in whatever consumes it. This one carries its own CSS. What is themed by
 * hand either way is the same list of `--bn-*` variables — see `theme.css`.
 */
const schema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    [DRAWING_BLOCK]: drawingBlockSpec(),
    /* Tabs, as a pair: the strip and one marker per tab, with the tab's blocks
       under the marker as its children. Why it takes two specs rather than one is
       at the top of `tabs-block.tsx`. */
    [TAB_LIST_BLOCK]: tabListBlockSpec(),
    [TAB_BLOCK]: tabBlockSpec(),
    /* Not a block a note ever holds — it stands in for one this schema has no
       spec for, and it exists only between `foldUnsupported` on the way in and
       `unfoldUnsupported` on the way out. See `unsupported.tsx`. */
    [UNSUPPORTED_BLOCK]: unsupportedBlockSpec(),
  },
})

/* The blocks and the styles a `.md` cannot keep, taken out of the schema rather
   than merely hidden. */
const { toggleListItem: _toggleListItem, ...markdownBlockSpecs } =
  defaultBlockSpecs
const {
  underline: _underline,
  textColor: _textColor,
  backgroundColor: _backgroundColor,
  ...markdownStyleSpecs
} = defaultStyleSpecs

/**
 * The same editor over a markdown file, with everything markdown would silently
 * eat left out of it.
 *
 * **Out of the schema, not off the menus**, and that is the whole point.
 * BlockNote binds `Mod+U` to underline and `Mod+Shift+6` to a toggle list, it
 * builds its own slash menu out of what the schema has, and a paste carries
 * whatever the clipboard held — so a feature that is only missing from a menu is
 * a feature somebody still reaches, and reaches into a file that cannot hold it.
 * Take the spec away and the shortcut is a no-op, the slash item is not built,
 * and the paste arrives as plain text of itself.
 *
 * What each one costs, in `whatMarkdownDrops`' own words: a toggle list "comes
 * back as bullets", a tab group "comes back as a heading" each, and colours,
 * alignment and underline have no syntax at all. Colours and alignment are block
 * *props* on every default spec rather than specs of their own, so those two are
 * taken off the toolbar and the drag-handle menu below instead — the only place
 * they can be.
 *
 * Everything markdown has no syntax for but which survives the trip whole — a
 * drawing, a video, an audio clip, an attachment — stays. Those ride back and
 * forth in a `<!-- note … -->` comment (`host/note-markdown.ts`), so a `.md`
 * holds them exactly and every other markdown reader ignores them.
 */
const markdownSchema = BlockNoteSchema.create({
  blockSpecs: {
    ...markdownBlockSpecs,
    [DRAWING_BLOCK]: drawingBlockSpec(),
    [UNSUPPORTED_BLOCK]: unsupportedBlockSpec(),
  },
  styleSpecs: markdownStyleSpecs,
})

type Editor = typeof schema.BlockNoteEditor

/**
 * The schema for the file being edited.
 *
 * The cast is the one place this file admits the two schemas are different
 * types: they differ in exactly the specs above, and nothing below asks either
 * of them for anything the other has not got. Typing every helper against the
 * union instead would spread three type parameters over a menu item and a
 * toolbar button for no reader's benefit.
 */
function schemaFor(format: NoteFormat): typeof schema {
  return format === "markdown"
    ? (markdownSchema as unknown as typeof schema)
    : schema
}

/** Whether a schema can draw this block itself, rather than folding it into a
 * listing of its JSON. */
function known(type: string, active: typeof schema): boolean {
  return type !== UNSUPPORTED_BLOCK && type in active.blockSchema
}

/*
 * The copy, checked against the original, once, on load.
 *
 * `EDITOR_BLOCK_TYPES` is what the MCP server tells a model it may write, and it
 * is a list written down in another file rather than read off this schema — which
 * the server cannot import, because this module is a browser one. A fork like that
 * drifts the moment a block spec is added here, and the way it would show up is
 * the worst kind: a model told a block is unsupported when it is, or worse, not
 * told when it is not. The console is where whoever added the spec will be.
 *
 * `unsupportedBlock` is left out of the comparison deliberately. It is the one
 * type in the schema that is *not* a block a note may hold — see `unsupported.tsx`
 * — so a note is right to call it unknown and the list is right not to name it.
 */
{
  const real = Object.keys(schema.blockSchema)
    .filter((type) => type !== UNSUPPORTED_BLOCK)
    .sort()
  const listed = [...EDITOR_BLOCK_TYPES].sort()
  const missing = real.filter((type) => !listed.includes(type))
  const extra = listed.filter((type) => !real.includes(type))
  if (missing.length || extra.length) {
    console.warn(
      "EDITOR_BLOCK_TYPES has drifted from the editor's schema — update " +
        "src/note-schema.ts, which is what the MCP server tells models.",
      { missingFromTheList: missing, notInTheSchema: extra }
    )
  }
}

/** The `/drawing` item's mark in the menu — lucide's `shapes`, inlined because
 * this extension has no icon library and one glyph is not a reason for one. */
const DrawingIcon = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M8.3 10a.7.7 0 0 1-.626-1.079L11.4 3a.7.7 0 0 1 1.198-.043L16.3 8.9a.7.7 0 0 1-.572 1.1Z" />
    <rect x="3" y="14" width="7" height="7" rx="1" />
    <circle cx="17.5" cy="17.5" r="3.5" />
  </svg>
)

/** Inserts a drawing and opens the canvas on it: picking "Drawing" from the menu
 * is a request to draw, not to place an empty box and then find the way into
 * it. */
function drawingItem(editor: Editor) {
  return {
    title: "Drawing",
    subtext: "Shapes, arrows and freehand, on a canvas",
    aliases: ["draw", "excalidraw", "diagram", "sketch"],
    group: "Advanced",
    icon: <DrawingIcon />,
    onItemClick: () => {
      const id = newDrawingId()
      const current = editor.getTextCursorPosition().block

      // The block the `/` was typed in is empty by the time an item is picked, so
      // the drawing takes its place rather than leaving a blank line above itself.
      editor.replaceBlocks(
        [current],
        [{ type: DRAWING_BLOCK, props: { drawingId: id } }]
      )
      openDrawing(id)
    },
  }
}

/**
 * The buttons a markdown file has nothing to write down.
 *
 * Colour and alignment are block props rather than style specs, so unlike
 * underline and toggle lists they cannot be taken out of the schema — a button
 * that is still on the toolbar is the only way to set them, and taking it off is
 * the only way not to. Underline is in here too even though its spec is gone:
 * `getFormattingToolbarItems()` is a static list, and a button for a style the
 * schema has not got is a button that does nothing when pressed.
 */
const MARKDOWN_HIDES = new Set([
  "colorStyleButton",
  "underlineStyleButton",
  "textAlignLeftButton",
  "textAlignCenterButton",
  "textAlignRightButton",
])

/**
 * The toolbar, with the one button BlockNote leaves out.
 *
 * `code` is one of the five marks in the default style schema, it is bound to
 * `Mod+E`, and it is the only one of the five with no button in
 * `getFormattingToolbarItems()`. So inline code was a style a note could hold,
 * the MCP server could write and this editor could draw, with nothing on screen
 * to turn it on or off — and its shortcut was going to VS Code's quick open
 * until `shortcuts.ts` claimed it back.
 *
 * Everything else is the default list in the default order; the button goes in
 * beside the other four marks, which is where someone would look for it.
 */
function toolbarItems(format: NoteFormat): ReactElement[] {
  const items = getFormattingToolbarItems().filter(
    (item) => format === "note" || !MARKDOWN_HIDES.has(String(item.key))
  )
  const code = (
    <BasicTextStyleButton basicTextStyle="code" key="codeStyleButton" />
  )
  const strike = items.findIndex((item) => item.key === "strikeStyleButton")
  if (strike < 0) return [...items, code]
  return [...items.slice(0, strike + 1), code, ...items.slice(strike + 1)]
}

/**
 * The drag handle's menu, without **Colors**.
 *
 * The default menu is Delete, Colors, Header row, Header column — and Colors is
 * the second way into the block props the toolbar's colour button sets, so
 * hiding one and not the other would hide nothing. Header column goes as well:
 * a markdown table has a header row and no such thing as a header column, and
 * `tables.headers` is off for both files anyway.
 */
function MarkdownDragHandleMenu(): ReactElement {
  const dictionary = useDictionary()
  return (
    <DragHandleMenu>
      <RemoveBlockItem>{dictionary.drag_handle.delete_menuitem}</RemoveBlockItem>
      <TableRowHeaderItem>
        {dictionary.drag_handle.header_row_menuitem}
      </TableRowHeaderItem>
    </DragHandleMenu>
  )
}

/** The `/tab` item's mark — lucide's `columns-3`, inlined for the same reason
 * the drawing's is: one glyph is not a reason for an icon library. */
const TabsIcon = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M9 3v18M15 3v18" />
  </svg>
)

/** Inserts a tab group in place of the block the `/` was typed in — the same
 * replacement `/drawing` makes, and for the same reason: the block is empty by
 * the time an item is picked, so leaving it would open the group under a blank
 * line. */
function tabsItem(editor: Editor) {
  return {
    title: "Tabs",
    subtext: "Three panes of blocks, one showing at a time",
    aliases: ["tab", "tabs", "panes", "sections"],
    group: "Advanced",
    icon: <TabsIcon />,
    onItemClick: () => {
      const current = editor.getTextCursorPosition().block
      editor.replaceBlocks([current], [newTabs()])
    },
  }
}

export function NoteEditor({
  initial,
  theme,
  dirUri,
  format,
  onChange,
}: {
  /** The document, read once. The editor takes its content at construction, so
   * the component above keys on the document to replace it. */
  initial: NoteBlock[]
  theme: "dark" | "light"
  /** The note's own directory, as a URL the webview may load from. */
  dirUri: string
  /** Which file these blocks are kept in, and so how much of the editor there
   * is. See `markdownSchema` above. */
  format: NoteFormat
  onChange: (blocks: NoteBlock[]) => void
}) {
  const markdown = format === "markdown"
  const active = schemaFor(format)
  // The editor is built once and never rebuilt, so it reaches its caller through
  // a ref rather than closing over an `onChange` a later render would replace.
  const write = useRef(onChange)
  useEffect(() => {
    write.current = onChange
  }, [onChange])

  const resolve = useCallback(
    async (url: string) => {
      // Only what this extension wrote: a picture's path is relative to the note.
      // Anything with a scheme of its own — an image embedded from the web, a
      // `data:` URL pasted out of a browser — is already loadable and is left
      // exactly as it is.
      if (!url || /^[a-z][a-z0-9+.-]*:/i.test(url)) return url
      return `${dirUri}/${url}`
    },
    [dirUri]
  )

  const editor = useCreateBlockNote(
    useMemo(
      () => ({
        schema: active,
        /*
         * BlockNote refuses an empty array, and a note nobody has typed into is
         * exactly that — left out, it starts on its own empty paragraph.
         *
         * Folded on the way in: a block this schema has no spec for would throw
         * from `blockToNode` here, which is inside the constructor, which is
         * inside render — so one unknown block in a note of seventy would cost
         * the whole document. `unfoldUnsupported` in `onChange` is the other half.
         */
        initialContent:
          initial.length > 0
            ? (foldUnsupported(initial, (type) =>
                known(type, active)
              ) as unknown as (typeof schema.PartialBlock)[])
            : undefined,
        /*
         * What a paste keeps: the formatting the copied thing actually had.
         *
         * BlockNote's default is `prioritizeMarkdownOverHTML: true` — when the
         * clipboard's `text/plain` fallback *looks* like markdown it throws the
         * `text/html` away and re-parses that instead. The heuristic fires on a
         * bullet, a `*`, a `#` line or a `|`, so pasting a formatted document out
         * of a browser routinely took the plain-text branch: a heading arrived as
         * a paragraph, `*starred*` arrived italic where the source was bold, and
         * a table arrived as one paragraph of run-together cells.
         */
        pasteHandler: ({
          defaultPasteHandler,
        }: {
          defaultPasteHandler: (options: {
            prioritizeMarkdownOverHTML: boolean
          }) => boolean | undefined
        }) => defaultPasteHandler({ prioritizeMarkdownOverHTML: false }),
        /*
         * A table cell with a colour on it, which a note could already hold and
         * nothing in the editor could produce.
         *
         * BlockNote ships every table feature off — `cellBackgroundColor` and
         * `cellTextColor` default to `false` — and with all of them off it draws
         * no cell handle at all, which is the button the colour menu hangs from.
         * So a cell tinted by the MCP server, or by hand in the file, rendered
         * exactly as it should in the editor and in both exports (`tint` in
         * `note-html.ts` has read cell props from the start) while there was no
         * way to tint one by hand.
         *
         * The bag's other two switches stay off on purpose: `splitCells` writes
         * merged cells, which the markdown export can only report as lost, and
         * `headers` adds header *columns*, which neither export draws as one.
         */
        tables: markdown
          ? /* None of the three over a `.md`: a tinted cell has no markdown to be
               written as, and `whatMarkdownDrops` would only be reporting a
               colour this editor had just offered to add. */
            {}
          : { cellBackgroundColor: true, cellTextColor: true },
        /**
         * The Upload tab in the image panel, and what makes dropping or pasting a
         * picture work at all: BlockNote builds that panel out of what the editor
         * can do, so with no `uploadFile` it offers only a URL to embed.
         */
        uploadFile: async (file: File) => upload(file, await base64Of(file)),
        resolveFileUrl: resolve,
      }),
      // Once. Rebuilding the editor is what the key on the component above is
      // for; doing it from here would drop the document mid-edit. `format` is
      // not a dependency for the same reason it is not a prop that changes: a
      // document does not change extension while it is open.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      []
    )
  )

  return (
    <>
      <BlockNoteView
        editor={editor}
        theme={theme}
        /* What the stylesheet hangs the last of the markdown restrictions off:
           a picture's drag-to-resize handle, which writes a `previewWidth` no
           markdown can carry. It is a handle rather than a menu item or a
           shortcut, so hiding it is the whole of taking it away. See
           `theme.css`. */
        className={markdown ? "note-markdown" : undefined}
        // Both replaced below, so `/drawing` sits among the default slash menu
        // items and the code button among the default toolbar ones, rather than
        // either of them arriving in a second menu of its own.
        slashMenu={false}
        formattingToolbar={false}
        // The drag handle's own menu is replaced for a markdown file, and only
        // there: its **Colors** submenu is the second way into the block props
        // the toolbar's colour button sets.
        sideMenu={markdown ? false : undefined}
        // Unfolded on the way out, so what reaches the document is the note's own
        // blocks and never this schema's stand-in for one.
        onChange={() =>
          write.current(unfoldUnsupported(editor.document as NoteBlock[]))
        }
      >
        <FormattingToolbarController
          formattingToolbar={() => (
            <FormattingToolbar>{toolbarItems(format)}</FormattingToolbar>
          )}
        />

        {markdown ? (
          <SideMenuController
            sideMenu={() => <SideMenu dragHandleMenu={MarkdownDragHandleMenu} />}
          />
        ) : null}

        <SuggestionMenuController
          triggerCharacter="/"
          getItems={async (query) =>
            filterSuggestionItems(
              [
                /* Built from the schema, so the items for what a markdown file
                   cannot hold — the toggle list, above all — are not in this
                   list to be filtered out. */
                ...getDefaultReactSlashMenuItems(editor),
                drawingItem(editor),
                // Tabs are the one block this extension adds that markdown
                // flattens: a group of three comes back as three headings.
                ...(markdown ? [] : [tabsItem(editor)]),
              ],
              query
            )
          }
        />
      </BlockNoteView>

      <DrawingHost theme={theme} />
    </>
  )
}

/**
 * Opens the drawing editor when a block in the document asks for it.
 *
 * The asking is an event rather than a prop, because what raises it is a block far
 * below any component that could have been handed a callback — and because the
 * slash menu raises it too.
 */
function DrawingHost({ theme }: { theme: "dark" | "light" }) {
  const [drawingId, setDrawingId] = useState<string | null>(null)

  useEffect(() => onDrawingOpened(setDrawingId), [])

  if (drawingId === null) return null
  return (
    <DrawingEditor
      drawingId={drawingId}
      theme={theme}
      onClose={() => setDrawingId(null)}
    />
  )
}
