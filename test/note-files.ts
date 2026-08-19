/**
 * What a file dropped into a note is stored as.
 *
 * The half of `host/note-files.ts` that decides a *name*, which is the one thing
 * in this extension that turns something the user's filesystem chose into a path
 * of ours. Before the shared assets directory it did not have to: a stored file
 * was a UUID, and a UUID cannot be a `..`. Now the name is kept, so the checks
 * that used to be structural have to be tested.
 *
 * Plain asserts and a count, in the style of the tests beside it.
 */

import { assetFilenameFor, contentTypeOf, extensionFor } from "../src/host/note-files"

let failures = 0
function check(what: string, ok: boolean, detail?: unknown) {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}`)
  if (!ok) {
    failures += 1
    if (detail !== undefined) console.log(`       ${String(detail)}`)
  }
}

console.log("the name a dropped file keeps")

check(
  "an ordinary one, as it was",
  assetFilenameFor("diagram.png", "image/png") === "diagram.png",
  assetFilenameFor("diagram.png", "image/png")
)
check(
  "the extension comes from the type, not the name it arrived with",
  assetFilenameFor("screenshot.jpg", "image/png") === "screenshot.png",
  assetFilenameFor("screenshot.jpg", "image/png")
)
check(
  "a paste out of the clipboard has no name and still gets one",
  assetFilenameFor("", "image/png") === "file.png",
  assetFilenameFor("", "image/png")
)
check(
  "a type this app has no entry for falls back to the name's own suffix",
  assetFilenameFor("notes.tar", "application/x-tar") === "notes.tar",
  assetFilenameFor("notes.tar", "application/x-tar")
)

console.log("\nkept readable")

check(
  "spaces become dashes rather than the name being thrown away",
  assetFilenameFor("Q3 planning notes.pdf", "application/pdf") ===
    "Q3-planning-notes.pdf",
  assetFilenameFor("Q3 planning notes.pdf", "application/pdf")
)
check(
  "letters outside ASCII are letters — this is a filename, not an identifier",
  assetFilenameFor("báo cáo.pdf", "application/pdf") === "báo-cáo.pdf",
  assetFilenameFor("báo cáo.pdf", "application/pdf")
)
check(
  "and so are Japanese ones",
  assetFilenameFor("設計図.png", "image/png") === "設計図.png",
  assetFilenameFor("設計図.png", "image/png")
)
check(
  "a run of punctuation collapses to one dash",
  assetFilenameFor("shape (2) [final].png", "image/png") ===
    "shape-2-final.png",
  assetFilenameFor("shape (2) [final].png", "image/png")
)
check(
  "a name with several dots keeps all but the last",
  assetFilenameFor("archive.tar.gz", "application/gzip") === "archive.tar.gz",
  assetFilenameFor("archive.tar.gz", "application/gzip")
)

console.log("\nand safe, which is the half that used to be a UUID")

for (const [what, name] of [
  ["a path", "../../.ssh/id_rsa"],
  ["a Windows path", "..\\..\\secrets"],
  ["a bare climb", ".."],
  ["a leading dot, which would hide the file", ".env"],
  ["a percent, which would double-escape in a URL", "50%.png"],
  ["a colon and a pipe, which Windows refuses", "a:b|c.png"],
  ["a newline", "one\ntwo.png"],
] as const) {
  const stored = assetFilenameFor(name, "image/png")
  check(
    `${what} cannot leave the directory: ${JSON.stringify(name)}`,
    !stored.includes("/") &&
      !stored.includes("\\") &&
      !stored.startsWith(".") &&
      !stored.includes("%") &&
      stored.split("/").every((part) => part !== ".."),
    stored
  )
}

check(
  "a name that is nothing but punctuation still comes out a name",
  assetFilenameFor("---.png", "image/png") === "file.png",
  assetFilenameFor("---.png", "image/png")
)
check(
  "a name Windows reserves is not one",
  assetFilenameFor("CON.png", "image/png") === "file-CON.png",
  assetFilenameFor("CON.png", "image/png")
)
check(
  "and a very long one is cut rather than refused",
  assetFilenameFor(`${"a".repeat(300)}.png`, "image/png").length <= 65,
  assetFilenameFor(`${"a".repeat(300)}.png`, "image/png").length
)

console.log("\nthe table still reads in both directions")

check("a type to an extension", extensionFor("x", "video/quicktime") === "mov")
check("and back again", contentTypeOf("clip.mov") === "video/quicktime")

console.log(failures === 0 ? "\nall ok" : `\n${failures} failed`)
if (failures > 0) process.exit(1)
