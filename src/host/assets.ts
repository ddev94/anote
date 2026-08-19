import { randomBytes } from "node:crypto"
import * as vscode from "vscode"

import {
  assetsDirFor,
  isSharedAssetPath,
  legacyAssetsDirFor,
  type AnoteConfig,
} from "../config"
import type { Configs } from "./config"

/**
 * Where a note's files are — the one module in `src/host/` that answers that.
 *
 * **One pool, at the notes root.** A dropped file lands in
 * `<notesDir>/anote.assets/`, under its own name, and the document keeps the path
 * relative to the notes root with that directory's name on the front:
 * `anote.assets/diagram.png`. Every note in the folder shares it.
 *
 * That is a change from the layout this extension started with — a
 * `<note>.assets/` directory beside each note — and the reason is the thing that
 * layout could not do. Its name was derived from the note's *filename* at every
 * call site, so renaming `Spec.note` in the Explorer moved every lookup to
 * `Design.note.assets` while the files stayed in `Spec.note.assets`, and every
 * picture in the note went blank. Nothing warned, because nothing was watching:
 * rename is the Explorer's job and this extension has never had an opinion about
 * it (see the header of `extension.ts`). A fixed directory needs no opinion — a
 * note may be renamed, moved into a subfolder, or both, and its files are still
 * exactly where the document says they are.
 *
 * **The old directories are still read.** A note written before the pool holds
 * paths relative to *itself*, and `isSharedAssetPath` is the fork every read
 * takes: a path with the pool's prefix is resolved against the notes root, and
 * anything else against the note's own directory, which is where it has always
 * been. Nothing is written there any more and nothing is moved out of it — a
 * migration that rewrote somebody's notes to tidy up a directory name would be
 * this extension deciding something it was not asked to.
 */

/**
 * What a path in the pool is relative to — the notes root of the folder this note
 * is in.
 *
 * `folderFor` falls back to the *first* folder for a note that is in none of them,
 * which is the same answer `configs.for` gives and the same one for the same
 * reason: a note opened from outside the workspace is still governed by the
 * workspace it was opened in. The branch below is the window with no folder open
 * at all — a `.note` opened on its own from Finder. There is no notes root to hang
 * a pool off, so the note's own directory stands in for one: it is the only place
 * this window can be sure it may write.
 */
export function notesRootFor(note: vscode.Uri, configs: Configs): vscode.Uri {
  const folder = configs.folderFor(note)
  return folder ? configs.notesRoot(folder) : dirOf(note)
}

/** The pool, as a URI. The notes root and the workspace's `assets.dir`. */
export function assetsRootFor(note: vscode.Uri, configs: Configs): vscode.Uri {
  return vscode.Uri.joinPath(
    notesRootFor(note, configs),
    assetsDirFor(configs.for(note))
  )
}

/** **Legacy.** The directory this note kept its own files in before the pool. */
export function legacyAssetsRootFor(
  note: vscode.Uri,
  config: AnoteConfig
): vscode.Uri {
  return vscode.Uri.joinPath(
    dirOf(note),
    legacyAssetsDirFor(filenameOf(note), config)
  )
}

/**
 * The directory a path out of a document resolves against.
 *
 * The whole of what a caller needs to read a picture whose path it is holding,
 * and the reason `sourceFor` and the previews did not each grow their own
 * version of the fork.
 */
export function baseForAssetPath(
  note: vscode.Uri,
  configs: Configs,
  path: string
): vscode.Uri {
  return isSharedAssetPath(path, configs.for(note))
    ? notesRootFor(note, configs)
    : dirOf(note)
}

/**
 * Where a file the *editor* named lives — a drawing's scene, and the picture
 * exported from it.
 *
 * Wherever it already is, and the pool for one that is nowhere. That ordering is
 * what makes a note with an older drawing in it keep working *and* keep its
 * drawing where it is: reopening the scene finds it beside the note, and saving
 * it writes back to the same file rather than leaving a copy in the pool and a
 * stale original behind.
 *
 * The name is checked by `isAssetName` before it gets here — these are the two
 * calls where the *document* chooses a filename, so what arrives is held to the
 * shape this app writes rather than sanitised.
 */
export async function locateAsset(
  note: vscode.Uri,
  configs: Configs,
  name: string
): Promise<vscode.Uri> {
  const legacy = vscode.Uri.joinPath(
    legacyAssetsRootFor(note, configs.for(note)),
    name
  )
  if (await exists(legacy)) return legacy
  return vscode.Uri.joinPath(assetsRootFor(note, configs), name)
}

/** How many `-1`, `-2` names are tried before falling back to a random suffix. */
const ATTEMPTS = 200

/**
 * Writes a dropped file into `dir` under `filename`, or as close to it as is
 * free, and answers with the name it actually got.
 *
 * One pool for a whole folder of notes means two people, or one person twice,
 * will drop `screenshot.png` — so the name `assetFilenameFor` asked for is a
 * request rather than an answer. Three outcomes, in this order:
 *
 * - **Nothing is there.** It is written under the name it asked for.
 * - **Something is there and it is the same bytes.** Nothing is written and the
 *   existing file is pointed at. Dropping the same picture into two notes, or
 *   twice into one, leaves one file — which is the one thing a shared pool can do
 *   that a directory per note could not.
 * - **Something is there and it is different bytes.** `screenshot-1.png`, then
 *   `-2`, and so on. The existing file is never overwritten: it belongs to some
 *   other note, and this is the only place in the extension that could quietly
 *   replace it.
 *
 * The check and the write are not atomic, and `workspace.fs` offers nothing that
 * would make them so. Two uploads landing in the same millisecond can therefore
 * both pick the same free name — the second wins the file. That is a real race
 * and it is left as one: the alternative is a lock file in somebody's repository,
 * and the drop it protects against is a person dropping two files into one note
 * faster than a disk write.
 */
export async function storeAsset(
  dir: vscode.Uri,
  filename: string,
  bytes: Uint8Array
): Promise<string> {
  /* Explicitly, rather than relying on `writeFile` to make parents: it does, but
     only once the directory above it exists, and the pool's parent is the notes
     root — which for a `notesDir` nobody has created yet is not there either. */
  await vscode.workspace.fs.createDirectory(dir)

  const dot = filename.lastIndexOf(".")
  const stem = dot > 0 ? filename.slice(0, dot) : filename
  const extension = dot > 0 ? filename.slice(dot) : ""

  for (let attempt = 0; attempt <= ATTEMPTS; attempt++) {
    const candidate = attempt === 0 ? filename : `${stem}-${attempt}${extension}`
    const target = vscode.Uri.joinPath(dir, candidate)

    const held = await sizeOf(target)
    if (held === null) {
      await vscode.workspace.fs.writeFile(target, bytes)
      return candidate
    }
    /* The size first and the bytes only if it matches. This is the one branch
       that would otherwise read a file to answer a question about it, and a
       40MB clip dropped a second time is not worth reading twice to find out
       it is the same clip. */
    if (held === bytes.byteLength && (await sameBytes(target, bytes))) {
      return candidate
    }
  }

  /* Past two hundred `screenshot-N.png` the counter has stopped being useful and
     is only costing a `stat` per attempt. Random from here, which cannot collide
     in practice and does not have to be walked up to. */
  const unique = `${stem}-${randomBytes(4).toString("hex")}${extension}`
  await vscode.workspace.fs.writeFile(
    vscode.Uri.joinPath(dir, unique),
    bytes
  )
  return unique
}

/** The file's size, or null for one that is not there. */
async function sizeOf(uri: vscode.Uri): Promise<number | null> {
  try {
    return (await vscode.workspace.fs.stat(uri)).size
  } catch {
    return null
  }
}

async function sameBytes(uri: vscode.Uri, bytes: Uint8Array): Promise<boolean> {
  try {
    return Buffer.from(await vscode.workspace.fs.readFile(uri)).equals(bytes)
  } catch {
    // Read while something else was writing it. Not the same file, as far as
    // this is concerned — the caller goes on to the next name.
    return false
  }
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  return (await sizeOf(uri)) !== null
}

export function dirOf(uri: vscode.Uri): vscode.Uri {
  return uri.with({ path: uri.path.slice(0, uri.path.lastIndexOf("/")) })
}

export function filenameOf(uri: vscode.Uri): string {
  return uri.path.split("/").pop() ?? "note"
}
