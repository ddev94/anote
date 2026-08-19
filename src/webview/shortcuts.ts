/**
 * The keystrokes this editor keeps for itself.
 *
 * A webview does not own its keyboard. VS Code's own script listens for `keydown`
 * on this page's `window` and posts every one of them to the workbench, which
 * builds a copy of the event, dispatches it into its own window and runs whatever
 * keybinding matches. Nothing there knows a note is being edited, so `Mod+B` set
 * a word in bold *and* toggled the side bar, and `Mod+Shift+S` struck a word
 * through *and* opened Save As.
 *
 * That listener is on `window`; these are on `document`, which is the last stop
 * before it — so `stopPropagation()` here keeps a keystroke inside the page
 * without taking it away from anything that wanted it. Everything below has
 * already run: ProseMirror's handlers are on the editor element and Excalidraw's
 * are on `document` itself, and for a shortcut either of them handles, both have
 * already called `preventDefault()`. That last part matters twice over — a
 * prevented key is also a key macOS will not hand to its own View and Edit menus,
 * which are the other route to the same commands.
 */

/** `Mod`, as ProseMirror and Excalidraw both mean it: ⌘ on a Mac, Ctrl elsewhere.
 * Read once — the platform does not change under a running webview. */
const APPLE = /mac|iphone|ipad/i.test(navigator.userAgent)

function mod(event: KeyboardEvent): boolean {
  return APPLE
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey
}

/**
 * The marks BlockNote binds, and every one of them is a VS Code command too:
 * `B` the side bar, `I` inline chat, `U` the cursor's undo, `E` the quick open,
 * and with Shift, `S` is Save As.
 */
const MARKS = new Set(["b", "i", "u", "e"])

function isMark(event: KeyboardEvent): boolean {
  if (!mod(event) || event.altKey) return false
  const key = event.key.toLowerCase()
  return event.shiftKey ? key === "s" : MARKS.has(key)
}

/** Installed once, for as long as the note is on screen. */
export function claimEditorKeys(): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (isMark(event)) event.stopPropagation()
  }

  document.addEventListener("keydown", onKeyDown)
  return () => document.removeEventListener("keydown", onKeyDown)
}

/**
 * Paste, while a drawing is open.
 *
 * This one has to be taken back rather than merely kept quiet, and the reason is
 * that VS Code does not forward `Mod+V` — it *swallows* it. The webview script
 * calls `preventDefault()` on every copy, cut and paste when it is running under
 * Electron, on the grounds that the workbench will do the pasting on the page's
 * behalf, and what the workbench does with it depends on what it believes is
 * focused. With a picture on the clipboard that was a new editor tab holding the
 * image, and never the canvas the cursor was on.
 *
 * So: the keystroke is stopped before that script sees it, and the clipboard is
 * read here instead. A webview may do that — VS Code's Electron main grants
 * `clipboard-read` to `vscode-webview://` pages specifically — and what comes
 * back is handed to Excalidraw as the `paste` event it was always waiting for.
 * The same event Excalidraw's own "Paste" menu item raises, built the same way.
 *
 * Only while the canvas is open. In the note itself the workbench's paste lands
 * in the editor exactly as it should, and going around it would cost the
 * clipboard's private types — the ones that carry a copied block as a block.
 *
 * `canvas` is the element the drawing fills, and it is here for the pointer
 * rather than the paste: see `aimAt`.
 */
export function claimPaste(canvas: () => HTMLElement | null): () => void {
  /** Where the mouse really is, which is nowhere until it has been moved. */
  let pointer: { x: number; y: number } | null = null

  const onPointerMove = (event: PointerEvent) => {
    // Not the one raised below, or aiming would count as having been aimed.
    if (event.isTrusted) pointer = { x: event.clientX, y: event.clientY }
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (!isPaste(event)) return
    event.preventDefault()
    event.stopPropagation()
    if (!overCanvas(pointer)) aimAt(canvas())
    void pasteFromSystem()
  }

  document.addEventListener("pointermove", onPointerMove)
  document.addEventListener("keydown", onKeyDown)
  return () => {
    document.removeEventListener("pointermove", onPointerMove)
    document.removeEventListener("keydown", onKeyDown)
  }
}

function overCanvas(at: { x: number; y: number } | null): boolean {
  if (!at) return false
  return document.elementFromPoint(at.x, at.y) instanceof HTMLCanvasElement
}

/**
 * A `pointermove` at the middle of the canvas.
 *
 * Excalidraw drops a paste unless the thing under the pointer is one of its
 * canvases, and it pastes at that point — both read from a position it keeps up
 * to date from `pointermove` on `document`, and which starts at the top left
 * corner of the page. A drawing that has just been opened has never seen the
 * mouse move over it, so without this the first paste into a new canvas is
 * silently nothing at all.
 */
function aimAt(canvas: HTMLElement | null): void {
  if (!canvas) return
  const box = canvas.getBoundingClientRect()
  document.dispatchEvent(
    new PointerEvent("pointermove", {
      clientX: box.left + box.width / 2,
      clientY: box.top + box.height / 2,
      bubbles: true,
    })
  )
}

function isPaste(event: KeyboardEvent): boolean {
  // Shift+Insert as well: it is the other paste on a keyboard that has it, and
  // VS Code swallows that one too.
  if (event.shiftKey && event.key === "Insert") return true
  return mod(event) && !event.altKey && !event.shiftKey && event.key === "v"
}

async function pasteFromSystem(): Promise<void> {
  const transfer = new DataTransfer()

  try {
    for (const item of await navigator.clipboard.read()) {
      for (const type of item.types) {
        const blob = await item.getType(type)
        if (type.startsWith("text/")) transfer.setData(type, await blob.text())
        // A name because `DataTransfer` wants one; nothing reads it, the type is
        // what Excalidraw looks at.
        else transfer.items.add(new File([blob], nameFor(type), { type }))
      }
    }
  } catch (error) {
    // A clipboard that will not be read is not a reason to lose the keystroke:
    // this is the paste VS Code would have asked the page for, and Chromium
    // allows it here for the same permission the read above needed.
    console.error("Could not read the clipboard", error)
    document.execCommand("paste")
    return
  }

  document.dispatchEvent(
    new ClipboardEvent("paste", {
      clipboardData: transfer,
      bubbles: true,
      cancelable: true,
    })
  )
}

function nameFor(type: string): string {
  const suffix = type.split("/")[1]?.split("+")[0] ?? "bin"
  return `clipboard.${suffix}`
}
