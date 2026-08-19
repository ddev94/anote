import { readFileSync } from "node:fs"

import {
  assetsDirFor,
  isSharedAssetPath,
  legacyAssetsDirFor,
  CONFIG_FILE,
  DEFAULT_CONFIG,
  parseConfig,
  PREVIEW_THEMES,
} from "../src/config"

/**
 * `anote.config.json`, as the extension reads it.
 *
 * The claim worth testing is one sentence: **a config file cannot stop ANote
 * from starting, and cannot make it write outside the workspace.** Everything
 * below is one of those two.
 *
 * The first half is the whole reason `parseConfig` returns problems rather than
 * throwing — a value that does not check out is replaced and reported, and the
 * extension activates on the rest of the file. The second is `notesDir`,
 * `assets.dir` and `assets.dirSuffix`, which are the three settings that become
 * *paths*: a folder new notes are written into and the root an agent is handed,
 * a directory joined onto that root, and a suffix joined onto a filename. All
 * three are checked here rather than at the call sites, which is why the call
 * sites can join them without thinking.
 *
 * Plain asserts and a count, in the style of the tests beside it.
 */

let failures = 0

function check(what: string, ok: boolean, detail?: unknown) {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}`)
  if (!ok) {
    failures += 1
    if (detail !== undefined) console.log(`       ${String(detail)}`)
  }
}

console.log("a workspace that has said nothing")

check(
  "no config file at all is the defaults, with nothing to report",
  JSON.stringify(parseConfig(undefined).config) ===
    JSON.stringify(DEFAULT_CONFIG) &&
    parseConfig(undefined).problems.length === 0
)
check(
  "and so is an empty object",
  JSON.stringify(parseConfig({}).config) === JSON.stringify(DEFAULT_CONFIG) &&
    parseConfig({}).problems.length === 0
)
check(
  "a config that is not an object is refused rather than read",
  parseConfig([1, 2, 3]).problems.length === 1 &&
    JSON.stringify(parseConfig([1, 2, 3]).config) ===
      JSON.stringify(DEFAULT_CONFIG),
  parseConfig([1, 2, 3]).problems.join(" ")
)

console.log("\na workspace that has")

{
  const { config, problems } = parseConfig({
    notesDir: "docs/notes",
    newNote: { defaultName: "Note" },
    assets: { dir: "media", dirSuffix: "_files" },
    preview: { theme: "dark", pollMs: 500, port: 4321 },
    mcp: { enabled: false },
  })
  check(
    "every key is taken as written",
    problems.length === 0,
    problems.join(" ")
  )
  check("notesDir", config.notesDir === "docs/notes", config.notesDir)
  check("newNote.defaultName", config.newNote.defaultName === "Note")
  check("assets.dir", config.assets.dir === "media", config.assets.dir)
  check("assets.dirSuffix", config.assets.dirSuffix === "_files")
  check("preview.theme", config.preview.theme === "dark")
  check("preview.pollMs", config.preview.pollMs === 500)
  check("preview.port", config.preview.port === 4321)
  check("mcp.enabled", config.mcp.enabled === false)
}

console.log("\nnothing in it can stop the extension starting")

for (const [what, raw] of [
  ["a string where an object goes", { preview: "dark" }],
  ["a number where a string goes", { notesDir: 7 }],
  ["a poll of zero", { preview: { pollMs: 0 } }],
  ["a poll of a day", { preview: { pollMs: 86_400_000 } }],
  ["a fractional port", { preview: { port: 8080.5 } }],
  ["a port past the end of the range", { preview: { port: 70_000 } }],
  ["a theme nobody has", { preview: { theme: "sepia" } }],
  ["mcp.enabled as a string", { mcp: { enabled: "yes" } }],
  ["a name with a slash in it", { newNote: { defaultName: "a/b" } }],
] as const) {
  const { config, problems } = parseConfig(raw)
  check(
    `${what} falls back and says so`,
    problems.length > 0 &&
      JSON.stringify(config) === JSON.stringify(DEFAULT_CONFIG),
    problems.join(" ")
  )
}

console.log("\nand nothing in it can name a path outside the workspace")

for (const escape of [
  "../secrets",
  "notes/../../secrets",
  "..",
  "/etc",
  "C:/Windows",
  "\\..\\secrets",
]) {
  const { config, problems } = parseConfig({ notesDir: escape })
  check(
    `notesDir ${escape} is refused`,
    config.notesDir === DEFAULT_CONFIG.notesDir && problems.length === 1,
    problems.join(" ")
  )
}

check(
  "a notesDir that only looks like one is not — `..foo` is a real folder name",
  parseConfig({ notesDir: "..foo" }).config.notesDir === "..foo"
)
check(
  "a trailing slash is not a second empty segment",
  parseConfig({ notesDir: "notes/" }).config.notesDir === "notes"
)
check(
  ". is the workspace folder itself",
  parseConfig({ notesDir: "." }).config.notesDir === "."
)

for (const suffix of ["../x", "a/b", "a\\b", "", "x".repeat(33)]) {
  const { config, problems } = parseConfig({ assets: { dirSuffix: suffix } })
  check(
    `assets.dirSuffix ${JSON.stringify(suffix)} is refused`,
    config.assets.dirSuffix === DEFAULT_CONFIG.assets.dirSuffix &&
      problems.length === 1,
    problems.join(" ")
  )
}

check(
  "so the directory an older note's files are read from is always one segment",
  !legacyAssetsDirFor(
    "Spec.note",
    parseConfig({ assets: { dirSuffix: "../../etc" } }).config
  ).includes("/"),
  legacyAssetsDirFor(
    "Spec.note",
    parseConfig({ assets: { dirSuffix: "../../etc" } }).config
  )
)
check(
  "and it is the note's own filename with the suffix on it",
  legacyAssetsDirFor("Spec.note", DEFAULT_CONFIG) === "Spec.note.assets"
)

for (const dir of ["../x", "a/b", "a\\b", "", ".", "..", "x".repeat(65)]) {
  const { config, problems } = parseConfig({ assets: { dir } })
  check(
    `assets.dir ${JSON.stringify(dir)} is refused`,
    config.assets.dir === DEFAULT_CONFIG.assets.dir && problems.length === 1,
    problems.join(" ")
  )
}

check(
  "so the directory every note's files go in is always one segment",
  !assetsDirFor(parseConfig({ assets: { dir: "../../etc" } }).config).includes(
    "/"
  ),
  assetsDirFor(parseConfig({ assets: { dir: "../../etc" } }).config)
)
check(
  "and by default it is anote.assets, under the notes root",
  assetsDirFor(DEFAULT_CONFIG) === "anote.assets"
)

check(
  "a path in that directory is recognised by its prefix",
  isSharedAssetPath("anote.assets/diagram.png", DEFAULT_CONFIG)
)
check(
  "an older note's path is not, so it goes on resolving against the note",
  !isSharedAssetPath("Spec.note.assets/diagram.png", DEFAULT_CONFIG)
)
check(
  "and neither is a note whose own directory merely starts with that name",
  !isSharedAssetPath("anote.assets.note.assets/diagram.png", DEFAULT_CONFIG),
  "the slash in the prefix is what tells them apart"
)

console.log("\nthe file shipped beside the schema agrees with the schema")

{
  const schema = JSON.parse(
    readFileSync("schemas/anote.schema.json", "utf8")
  ) as {
    properties: Record<string, { properties?: Record<string, unknown> }>
  }
  const declared = Object.keys(schema.properties).filter(
    (key) => key !== "$schema"
  )
  check(
    "every key the config has is one the schema describes",
    JSON.stringify(declared.sort()) ===
      JSON.stringify(Object.keys(DEFAULT_CONFIG).sort()),
    declared.join(", ")
  )
  check(
    "the theme the schema offers is the theme the renderer knows",
    JSON.stringify(
      (schema.properties.preview?.properties?.theme as { enum: string[] }).enum
    ) === JSON.stringify([...PREVIEW_THEMES])
  )

  const example = JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as Record<
    string,
    unknown
  >
  check(
    `this repo's own ${CONFIG_FILE} parses with nothing to report`,
    parseConfig(example).problems.length === 0,
    parseConfig(example).problems.join(" ")
  )
}

console.log(failures === 0 ? "\nall ok" : `\n${failures} failed`)
if (failures > 0) process.exit(1)
