/**
 * Which theme the editor is on, for the parts of the webview that are not
 * components.
 *
 * The app reads this from `next-themes`, which is a React context — and a context
 * is no use to a block far down inside a node view BlockNote built, or to an export
 * running in an effect. So it is a value and a subscription: `main.tsx` sets it
 * from the host's `init` and `theme` messages, and whoever needs it asks.
 *
 * What needs it is the drawing block. Excalidraw *inverts* strokes for a dark
 * export rather than tinting them, so a diagram exported light on a dark editor is
 * black lines nobody can see — which is what a white card behind it was papering
 * over.
 */
type Theme = "dark" | "light"

let theme: Theme = "dark"
const listeners = new Set<(theme: Theme) => void>()

export function currentTheme(): Theme {
  return theme
}

export function setTheme(next: Theme): void {
  if (next === theme) return
  theme = next
  for (const listener of listeners) listener(next)
}

export function onThemeChanged(listener: (theme: Theme) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
