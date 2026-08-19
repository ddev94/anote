/**
 * Which tab of each tab group is open.
 *
 * Not in the document, deliberately, and this is the one decision the whole block
 * is built around. A tab group's open tab is a *reading* position, the same as a
 * toggle's open state — and BlockNote keeps that in `localStorage` under the
 * block's id (`createToggleWrapper.ts`) rather than in the note. Putting it in a
 * prop instead would make every click on a tab an edit: the document changes, the
 * editor saves, the file on disk is rewritten, and a note nobody typed in comes
 * back modified in git. Reading is not writing.
 *
 * What that costs is that two people opening the same note do not see the same
 * tab, and that the note itself cannot say which tab to open first. Both are the
 * toggle's bargain too, and the first tab is a sane answer to the second.
 *
 * The key is the tab *block's* id rather than the group's index, so a group that
 * gains or loses a tab above the open one does not silently switch which one is
 * showing.
 */

/** One entry per tab group: the group's block id, and the id of its open tab. */
const KEY = (group: string) => `anote-tab-${group}`

const listeners = new Set<() => void>()

/**
 * The open tab of `group`, given the tabs it has right now.
 *
 * `tabs` is passed in rather than looked up because the answer has to be checked
 * against it every time: what is remembered is an id, and the tab it names can
 * have been deleted since — by the person reading, by an edit from the MCP server,
 * or by a note that was replaced on disk. A remembered id that is no longer one of
 * the group's tabs is not an error, it is just out of date, and the first tab is
 * what a group with nothing remembered shows anyway.
 */
export function openTabOf(group: string, tabs: readonly string[]): string {
  const remembered = read(KEY(group))
  if (remembered && tabs.includes(remembered)) return remembered
  return tabs[0] ?? ""
}

export function openTab(group: string, tab: string): void {
  write(KEY(group), tab)
  for (const listener of [...listeners]) listener()
}

/**
 * Told when any group's open tab changes.
 *
 * Every tab in the note is notified rather than only the group that changed, and
 * that is on purpose: a tab panel knows its own id and its group's, so deciding
 * whether it is still the open one is a string comparison. Routing by group would
 * be a second index to keep correct for no work saved.
 */
export function onOpenTabChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/* `localStorage` is a webview's own, per note editor, and it can be unavailable
   — a webview with storage turned off throws on access rather than returning
   null. A tab group whose memory cannot be read is a tab group showing its first
   tab, which is the same thing it shows the first time anyone opens the note. */
function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    /* Then it is not remembered, and the click still works. */
  }
}
