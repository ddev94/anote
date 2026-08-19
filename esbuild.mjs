import { cp, mkdir } from "node:fs/promises"
import { build, context } from "esbuild"

/**
 * Four bundles, because there are four environments — two of which are the same
 * split the app makes between its main process and its renderer, and for the same
 * reason: they share no globals.
 *
 * The host runs in the extension host, which is Node, and must not bundle
 * `vscode` — that module is handed to it at runtime and does not exist on disk.
 * The webview is a browser page with no Node in it at all. The MCP server is
 * Node again, but a process of its own started by something that is not VS Code,
 * so it bundles everything it uses and imports no `vscode` at all — which is a
 * thing esbuild will say out loud if it ever stops being true.
 *
 * The fourth is the studio: the same editor as the webview, in an ordinary browser
 * tab, served over a socket by `src/host/studio-server.ts`. It is a second entry
 * point rather than a second copy — it imports `src/webview/editor.tsx` — and it
 * needs its own bundle for the reason any page does: a `<script>` is one file, and
 * this one has a sidebar in it that the webview must not carry.
 */
const watch = process.argv.includes("--watch")

/** @type {import("esbuild").BuildOptions} */
const host = {
  entryPoints: ["src/host/extension.ts"],
  outfile: "dist/extension.js",
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  external: ["vscode"],
  sourcemap: true,
  minify: !watch,
}

/**
 * The notes, as an MCP server — a program in its own right, started by whatever
 * is doing the reading rather than by VS Code. See `src/mcp/main.ts`.
 *
 * Not minified even when the extension is: this is the file somebody points a
 * client at and then wonders what it is doing, and a stack trace out of it should
 * name the function it came from.
 *
 * @type {import("esbuild").BuildOptions}
 */
const mcp = {
  entryPoints: ["src/mcp/main.ts"],
  outfile: "dist/mcp.js",
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  sourcemap: true,
  banner: { js: "#!/usr/bin/env node" },
}

/** @type {import("esbuild").BuildOptions} */
const webview = {
  entryPoints: ["src/webview/main.tsx"],
  // esbuild writes the CSS its entry imports beside the JS, under the same name —
  // which is the pair `note-editor.ts` links into the page.
  outfile: "dist/webview.js",
  bundle: true,
  platform: "browser",
  target: "es2022",
  format: "iife",
  sourcemap: true,
  minify: !watch,
  // React reads this, and an unset `process` in a browser bundle is a page that
  // throws before it renders.
  define: { "process.env.NODE_ENV": watch ? '"development"' : '"production"' },
  /*
   * BlockNote's stylesheets reach each other by package name — `@blocknote/mantine`'s
   * own CSS opens with `@import url("@blocknote/react/style.css")` — and esbuild
   * resolves a package's `exports` map for an `import` in JS but not for an
   * `@import` in CSS. So the same specifier that works from `main.tsx` fails one
   * level down, at the file it pulls in, looking for a `style.css` that only the
   * exports map knows is really `dist/style.css`.
   *
   * Named here rather than worked around by importing the pieces in dependency
   * order, because the order is theirs to change and this is the one line that
   * says what is going on.
   */
  alias: {
    "@blocknote/core/style.css":
      "./node_modules/@blocknote/core/dist/style.css",
    "@blocknote/react/style.css":
      "./node_modules/@blocknote/react/dist/style.css",
    // And Excalidraw's, whose exports map offers only `development` and
    // `production` conditions — so the specifier resolves from neither CSS nor
    // TypeScript without being told where to look.
    "@excalidraw/excalidraw/index.css":
      "./node_modules/@excalidraw/excalidraw/dist/prod/index.css",
  },
  loader: {
    // Inlined rather than emitted as files: a webview may only load what is under
    // its `localResourceRoots`, and a font fetched from a relative URL inside a
    // stylesheet is one more thing to have to allow.
    ".woff": "dataurl",
    ".woff2": "dataurl",
    ".ttf": "dataurl",
    ".svg": "dataurl",
    ".png": "dataurl",
  },
}

/**
 * The studio's bundle — the same browser build as the webview's, on its own entry.
 *
 * Spread rather than repeated: every line of the webview's options above is a
 * decision about running BlockNote and Excalidraw in a browser, and both pages are
 * a browser. What differs is the entry, the name, and nothing else — so if the two
 * ever need to differ in a third way, that is a fact worth having to write down
 * here.
 *
 * @type {import("esbuild").BuildOptions}
 */
const studio = {
  ...webview,
  entryPoints: ["src/studio/main.tsx"],
  outfile: "dist/studio.js",
}

/**
 * Excalidraw's own fonts, copied where the webview can load them.
 *
 * It resolves them at runtime against `window.EXCALIDRAW_ASSET_PATH`, and left
 * unset that is `esm.sh` — a network fetch, from a page whose CSP allows none, for
 * files the package already ships. The host sets that variable to this directory's
 * webview URI (`note-editor.ts`), and the studio's page sets it to `/~/excalidraw/`
 * (`studio-server.ts`, which serves these same files); this is what puts the files
 * in it.
 *
 * The whole tree, which is around 13MB and mostly the CJK family Excalidraw only
 * fetches the subset it needs of. A real extension ships the families its defaults
 * actually use; a spike copies all of them and gets it right.
 */
async function copyExcalidrawAssets() {
  await mkdir("dist/excalidraw", { recursive: true })
  await cp(
    "node_modules/@excalidraw/excalidraw/dist/prod/fonts",
    "dist/excalidraw/fonts",
    {
      recursive: true,
    }
  )
}

await copyExcalidrawAssets()

if (watch) {
  const contexts = await Promise.all([
    context(host),
    context(webview),
    context(studio),
    context(mcp),
  ])
  await Promise.all(contexts.map((each) => each.watch()))
  console.log("watching")
} else {
  await Promise.all([build(host), build(webview), build(studio), build(mcp)])
}
