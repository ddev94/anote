import { useEffect, useMemo, useRef, useState } from "react"
import { createReactBlockSpec } from "@blocknote/react"

import { onOpenTabChanged, openTab, openTabOf } from "./tabs"

/**
 * Tabs in a note: one strip of names, one panel's worth of blocks showing at a
 * time, and the rest kept.
 *
 * **Why this is two block types rather than one.** BlockNote renders a block's
 * children *outside* the block — `.bn-block-content` holds what the block itself
 * draws and `.bn-block-group` is its sibling, holding the subtree — so a React
 * block spec cannot wrap its own children in anything, a panel included. Their
 * own multi-column blocks have the same problem and answer it the same way: a
 * `columnList` that draws nothing and a `column` per column, each carrying its
 * share of the content as children. `tabList` and `tab` are that, with a strip
 * on top.
 *
 * So the shape in the file is:
 *
 * ```
 * tabList
 *   tab  props.title = "Tab 1"
 *     paragraph, table, whatever else
 *   tab  props.title = "Tab 2"
 *     …
 * ```
 *
 * and a tab's own row draws nothing at all — it is a marker, hidden in
 * `theme.css`, whose only job is to carry `data-open` where CSS can see it and
 * hide the block group next to it. That is BlockNote's own trick for a closed
 * toggle (`.bn-block:has(… [data-show-children=false]) > .bn-block-group`), and
 * it is what keeps switching tabs out of the document: an attribute on a rendered
 * element is not an edit, so clicking a tab does not dirty the note. Where the
 * open tab *is* kept, and why, is `tabs.ts`.
 */
export const TAB_LIST_BLOCK = "tabList"
export const TAB_BLOCK = "tab"

/** What a fresh `/tab` puts in the note. Three, because one tab is not a tab
 * group and two looks like a mistake — and each with a paragraph in it, so there
 * is somewhere to type the moment it appears. */
export function newTabs(): {
  type: typeof TAB_LIST_BLOCK
  children: { type: typeof TAB_BLOCK; props: { title: string }; children: { type: "paragraph" }[] }[]
} {
  return {
    type: TAB_LIST_BLOCK,
    children: [1, 2, 3].map((at) => ({
      type: TAB_BLOCK as typeof TAB_BLOCK,
      props: { title: `Tab ${at}` },
      children: [{ type: "paragraph" as const }],
    })),
  }
}

export const tabListBlockSpec = createReactBlockSpec(
  {
    type: TAB_LIST_BLOCK,
    // The strip is drawn from the children's props; there is no text of its own
    // to put a caret in, and a selection must not stop between the tabs.
    content: "none",
    propSchema: {},
  },
  {
    render: ({ block, editor }) => (
      <TabStrip group={block.id} editor={editor as Editor} />
    ),
  }
)

export const tabBlockSpec = createReactBlockSpec(
  {
    type: TAB_BLOCK,
    content: "none",
    // The name on the strip. A prop rather than inline content because it is
    // read from the *parent's* render, where there is no way to reach into
    // another block's text — and because a tab title is a label, not a
    // paragraph that could hold a link or a picture.
    propSchema: { title: { default: "" } },
  },
  {
    render: ({ block, editor }) => (
      <TabMarker tab={block.id} editor={editor as Editor} />
    ),
  }
)

/* The editor, as much of it as this file uses. The real type is the schema's,
   which lives in `editor.tsx` and would import this one back. */
type Editor = {
  getBlock: (id: string) => AnyBlock | undefined
  getParentBlock: (id: string) => AnyBlock | undefined
  updateBlock: (id: string, update: unknown) => unknown
  insertBlocks: (blocks: unknown[], at: string, where: "before" | "after") => unknown
  removeBlocks: (ids: string[]) => unknown
  onChange: (listener: () => void) => (() => void) | undefined
  isEditable: boolean
}

type AnyBlock = {
  id: string
  type?: string
  props?: Record<string, unknown>
  children?: AnyBlock[]
}

/**
 * Re-read a block whenever the document changes.
 *
 * A node view is re-rendered when *its own* node changes, and the strip is drawn
 * from its children's props — renaming a tab is a change to a descendant, which
 * would leave the strip showing the old name until something else redrew it. So
 * the strip reads through the editor and this is the subscription that makes it
 * current.
 */
function useBlock(editor: Editor, id: string): AnyBlock | undefined {
  const [, bump] = useState(0)
  useEffect(() => editor.onChange(() => bump((n) => n + 1)), [editor])
  return editor.getBlock(id)
}

/** Told when any tab group's open tab changes — see `onOpenTabChanged`. */
function useOpenTab(): number {
  const [tick, bump] = useState(0)
  useEffect(() => onOpenTabChanged(() => bump((n) => n + 1)), [])
  return tick
}

function TabStrip({ group, editor }: { group: string; editor: Editor }) {
  const block = useBlock(editor, group)
  useOpenTab()

  /* Only the tabs. A block group takes whatever somebody indented into it, so a
     paragraph can end up here — by a Tab keypress, by a paste, or written by the
     MCP server. It is not given a name on the strip and it is not hidden either
     (see `theme.css`), which makes it visible enough to be noticed and moved. */
  const tabs = (block?.children ?? []).filter((child) => child.type === TAB_BLOCK)
  const open = openTabOf(group, tabs.map((tab) => tab.id))

  /** The tab being renamed, and the text so far. Held here rather than in the
   * document so that a half-typed name is not an undo step of its own. */
  const [renaming, setRenaming] = useState<string | null>(null)

  return (
    <div className="note-tabs" contentEditable={false}>
      {tabs.map((tab, at) =>
        renaming === tab.id ? (
          <TabName
            key={tab.id}
            initial={titleOf(tab, at)}
            done={(title) => {
              setRenaming(null)
              // An empty name would be an unclickable tab. Left alone rather
              // than refused: the old one is still the right answer.
              if (title.trim()) editor.updateBlock(tab.id, { props: { title } })
            }}
          />
        ) : (
          <button
            key={tab.id}
            type="button"
            className="note-tab-button"
            data-open={tab.id === open}
            // The editor takes the selection on mousedown, and taking it from
            // inside the note is what puts the caret somewhere the reader did
            // not click. The click still lands.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => openTab(group, tab.id)}
            onDoubleClick={() => editor.isEditable && setRenaming(tab.id)}
            title={editor.isEditable ? "Double-click to rename" : undefined}
          >
            {titleOf(tab, at)}
          </button>
        )
      )}

      {editor.isEditable && (
        <>
          <button
            type="button"
            className="note-tab-add"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              const last = tabs[tabs.length - 1]
              const added = {
                type: TAB_BLOCK,
                props: { title: `Tab ${tabs.length + 1}` },
                children: [{ type: "paragraph" }],
              }
              /* After the last tab if there is one. A group with none — every tab
                 deleted from the outline, or one the MCP server wrote empty —
                 has nothing to sit after, so the tab goes inside it as its first
                 child instead. */
              const id = last
                ? (editor.insertBlocks([added], last.id, "after") as AnyBlock[])[0]
                    ?.id
                : (editor.updateBlock(group, { children: [added] }) as AnyBlock)
                    .children?.[0]?.id
              // Opened, because adding a tab is a request to fill it.
              if (id) openTab(group, id)
            }}
            title="Add a tab"
            aria-label="Add a tab"
          >
            +
          </button>

          {/* The last tab is not removable: a tab group with no tabs has no strip
              left to add one from, and deleting the group is what the drag
              handle's own Delete is for. */}
          {tabs.length > 1 && (
            <button
              type="button"
              className="note-tab-remove"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                const at = tabs.findIndex((tab) => tab.id === open)
                if (at < 0) return
                // The neighbour, so the strip does not jump back to the first
                // tab every time one in the middle is removed.
                const next = tabs[at + 1] ?? tabs[at - 1]
                editor.removeBlocks([tabs[at]!.id])
                if (next) openTab(group, next.id)
              }}
              title="Remove the open tab"
              aria-label="Remove the open tab"
            >
              ×
            </button>
          )}
        </>
      )}
    </div>
  )
}

/** A tab with no name of its own is still a tab somebody has to be able to
 * click, so it is named by where it sits. */
function titleOf(tab: AnyBlock, at: number): string {
  const title = tab.props?.title
  return typeof title === "string" && title.trim() ? title : `Tab ${at + 1}`
}

/** The rename field: one line, committed on Enter or on leaving, abandoned on
 * Escape — which is what every rename in the editor around it does. */
function TabName({
  initial,
  done,
}: {
  initial: string
  done: (title: string) => void
}) {
  const [text, setText] = useState(initial)
  const field = useRef<HTMLInputElement>(null)
  // Mounted straight into a rename, so the name can be typed over immediately.
  useEffect(() => {
    field.current?.focus()
    field.current?.select()
  }, [])

  /* Committed once. `blur` fires on the way out of an Enter as well, and a second
     commit would be a second undo step holding the same name. */
  const settled = useRef(false)
  const settle = (title: string | null) => {
    if (settled.current) return
    settled.current = true
    done(title ?? initial)
  }

  const size = useMemo(() => Math.max(6, text.length + 1), [text])

  return (
    <input
      ref={field}
      className="note-tab-name"
      value={text}
      size={size}
      onChange={(event) => setText(event.currentTarget.value)}
      onBlur={() => settle(text)}
      onKeyDown={(event) => {
        // Kept off the note: Enter here is not a new block and Escape is not the
        // editor's own.
        event.stopPropagation()
        if (event.key === "Enter") settle(text)
        if (event.key === "Escape") settle(null)
      }}
    />
  )
}

/**
 * A tab's own row, which draws nothing.
 *
 * `data-open` is the whole of it, and `theme.css` is what reads it — the blocks
 * of a tab are its children, in the block group beside this element, and the CSS
 * hides that group when this says the tab is not the open one.
 */
function TabMarker({ tab, editor }: { tab: string; editor: Editor }) {
  useOpenTab()
  // Re-read on every change: which tabs the group has decides which one is open
  // when the remembered id has gone, and this element has to agree with the
  // strip about the answer.
  const [, bump] = useState(0)
  useEffect(() => editor.onChange(() => bump((n) => n + 1)), [editor])

  const parent = editor.getParentBlock(tab)
  /* A tab outside a tab group is not a tab. It can be got at by dragging one out
     or by an edit that wrote it at the top level, and hiding its content because
     no strip claims it would be losing somebody's blocks on screen. */
  const loose = parent?.type !== TAB_LIST_BLOCK
  const siblings = (parent?.children ?? [])
    .filter((child) => child.type === TAB_BLOCK)
    .map((child) => child.id)

  const open = loose || openTabOf(parent!.id, siblings) === tab

  return <div className="note-tab" data-open={open} contentEditable={false} />
}
