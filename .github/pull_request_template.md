## What this is for

<!-- The diff says what the change does. Say what it is for: the problem, the
     bug, the thing that was awkward. One or two sentences is plenty. -->

## Notes for the reviewer

<!-- Optional: an approach you rejected, a place you were unsure, a follow-up
     you deliberately left out. -->

## Checklist

- [ ] `bun run typecheck`, `bun run test` and `bun run build` pass locally
- [ ] If this crosses between the extension host and the webview, it goes
      through `src/protocol.ts` — the two sides still don't import each other
- [ ] If this changes what a `.note` holds, it round trips: written, read back,
      and the same document comes out (`test/note-format.ts`,
      `test/note-schema.ts`)
- [ ] If this changes what the editor offers over a `.md`, everything reachable
      in the menus survives a save (`test/note-markdown.ts`)
- [ ] If this adds a config key, it is optional, has a default, and a bad value
      is reported rather than fatal — and `schemas/anote.schema.json` and the
      README table know about it
- [ ] If this changes a command, a menu or a setting, the README is updated in
      this pull request; if it changes how something is built, so is
      `docs/design.md`
- [ ] No new file that only ever needed to exist on your machine, and no
      unrelated formatting churn
