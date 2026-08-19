/**
 * The two things the webview's world has that its types do not.
 *
 * `EXCALIDRAW_ASSET_PATH` is Excalidraw's own runtime hook for where to find its
 * fonts — a global it reads and does not declare. The host sets it in the page
 * before the bundle runs, so it is a fact about this webview rather than about
 * Excalidraw's API, which is why it is declared here and not imported.
 */
declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string
  }
}

/** A stylesheet imported for its side effect. esbuild turns it into a file beside
 * the bundle; TypeScript needs telling that the import is legal. */
declare module "*.css" {
  const styles: string
  export default styles
}

export {}
