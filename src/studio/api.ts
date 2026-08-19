import {
  API,
  BOOT_ID,
  FILE_PARAM,
  NOTE_PARAM,
  PATH_PARAM,
  TOKEN_HEADER,
  VERSION_HEADER,
  type AssetResult,
  type NoteEntry,
  type NoteResult,
  type NotesResult,
  type Problem,
  type SavedResult,
  type StudioBoot,
  type UploadedResult,
} from "../studio-api"

/**
 * The studio's end of the wire.
 *
 * One file, so the page has one place where a fetch happens and everything above
 * it is React — the same position `src/webview/bridge.ts` holds for the webview.
 * Every call goes through `ask` below, which is where the token is attached and
 * where a failure becomes a sentence somebody can read.
 */

/**
 * What the server put in the page.
 *
 * Read once, at module load, because the token is needed by the first request and
 * `document` is already parsed by the time the bundle runs — the script tag is
 * above it. A page without it is not a page this bundle was served by, and there is
 * nothing useful to do but say so.
 */
function readBoot(): StudioBoot {
  const element = document.getElementById(BOOT_ID)
  if (!element?.textContent) {
    throw new Error("This page carried no studio settings.")
  }
  return JSON.parse(element.textContent) as StudioBoot
}

export const boot: StudioBoot = readBoot()

/** Which note the page is on, off its own URL — `?note=`. The URL is the record,
 * so a reload and a copied link both come back to the note being read. */
export function noteInUrl(): string | null {
  return new URL(location.href).searchParams.get(NOTE_PARAM) || boot.note
}

/** Puts the note in the URL without navigating, which is what makes the back
 * button and a reload agree with the sidebar. */
export function rememberNoteInUrl(path: string | null): void {
  const url = new URL(location.href)
  if (path) url.searchParams.set(NOTE_PARAM, path)
  else url.searchParams.delete(NOTE_PARAM)
  history.replaceState(null, "", url)
}

/**
 * A failure the server described, rather than one the network invented.
 *
 * `problem` is written to be shown — see `Problem` in `src/studio-api.ts` — so
 * this is the error the page displays verbatim. `version` comes back on the one
 * failure that has something the page can *do* about it: a save against a note
 * that has moved on.
 */
export class Refused extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly version?: string
  ) {
    super(message)
  }
}

/**
 * One request, with the token on it.
 *
 * `no-store` throughout: everything here is "the note as it is right now", and a
 * browser that answered a poll out of its own cache would be the one thing that
 * makes the poll pointless.
 */
async function ask<T>(
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<T> {
  let response: Response
  try {
    response = await fetch(url, {
      method,
      cache: "no-store",
      headers: {
        [TOKEN_HEADER]: boot.token,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  } catch {
    /* The editor host has gone — the window was closed, or the extension was
       reloaded. Worth its own words, because it is the one failure that no amount
       of retrying will fix and the page cannot recover from on its own. */
    throw new Refused(
      "The studio's server is not answering — the VS Code window that started it may have closed.",
      0
    )
  }

  if (!response.ok) {
    const problem = (await response.json().catch(() => null)) as Problem | null
    throw new Refused(
      problem?.problem ?? `The studio answered ${response.status}.`,
      response.status,
      problem?.version
    )
  }
  return (await response.json()) as T
}

export async function listNotes(): Promise<NoteEntry[]> {
  return (await ask<NotesResult>("GET", API.notes)).notes
}

export async function createNote(path: string): Promise<NoteEntry> {
  return await ask<NoteEntry>("POST", API.notes, { path })
}

export async function readNote(path: string): Promise<NoteResult> {
  return await ask<NoteResult>("GET", noteUrl(path))
}

/** What the file is at now, without pulling it down — the poll. */
export async function noteVersion(path: string): Promise<string | null> {
  const response = await fetch(noteUrl(path), {
    method: "HEAD",
    cache: "no-store",
    headers: { [TOKEN_HEADER]: boot.token },
  })
  if (!response.ok) return null
  return (response.headers.get("etag") ?? "").replace(/"/g, "") || null
}

/**
 * The note, saved against the version it was loaded at.
 *
 * `version` is not optional and the server refuses a save without it: the studio
 * is the one editor of these files that cannot see the others — a VS Code tab, the
 * MCP server, a git checkout — so "write what I have" is never a safe thing for it
 * to ask. A `Refused` with a `version` on it is the case where the file moved, and
 * the page has something to offer rather than only bad news.
 */
export async function saveNote(
  path: string,
  text: string,
  version: string
): Promise<string> {
  const url = noteUrl(path)
  const response = await fetch(url, {
    method: "PUT",
    cache: "no-store",
    headers: {
      [TOKEN_HEADER]: boot.token,
      [VERSION_HEADER]: version,
      "content-type": "application/json",
    },
    body: text,
  })
  if (!response.ok) {
    const problem = (await response.json().catch(() => null)) as Problem | null
    throw new Refused(
      problem?.problem ?? `The studio answered ${response.status}.`,
      response.status,
      problem?.version
    )
  }
  return ((await response.json()) as SavedResult).version
}

export async function uploadFile(
  note: string,
  file: { name: string; mime: string; base64: string }
): Promise<string> {
  const result = await ask<UploadedResult>(
    "POST",
    `${API.upload}?${PATH_PARAM}=${encodeURIComponent(note)}`,
    file
  )
  return result.path
}

export async function readAsset(
  note: string,
  name: string
): Promise<string | null> {
  return (await ask<AssetResult>("GET", assetUrl(note, name))).base64
}

export async function writeAsset(
  note: string,
  name: string,
  base64: string
): Promise<void> {
  await ask<unknown>("PUT", assetUrl(note, name), { base64 })
}

function noteUrl(path: string): string {
  return `${API.note}?${PATH_PARAM}=${encodeURIComponent(path)}`
}

function assetUrl(note: string, name: string): string {
  return `${API.asset}?${PATH_PARAM}=${encodeURIComponent(note)}&${FILE_PARAM}=${encodeURIComponent(name)}`
}
