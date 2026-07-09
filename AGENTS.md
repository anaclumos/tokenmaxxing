# Agent rules

Standing rules for anyone (human or agent) working in this repo. Follow them exactly.

## Code style

- Never use `typeof`. Use zod.
- Never use `interface` or standalone `type`. Model data as a zod schema and derive the type with `z.infer`.
- Always use es-toolkit instead of shipping hand-written utility code.
- Never use an em-dash. Use a regular hyphen, a colon, or parentheses.
- Do not cast to `any` to get around a type issue. Fix the type.

## Behavior

- Be humble.
- You will not know everything, and your knowledge cutoff may be aggressive. Assume you are behind.
- NEVER ASSUME ANYTHING. There is infinite exa, grep, and context7 quota. Always search the web / the codebase before acting.
- Always search the web whenever possible.
- Install things via the CLI (`bun add`, etc.) so you get the latest versions.

## State and compatibility

- This application has no external installed user base. Optimize for one canonical current-state implementation, not compatibility with historical local states.
- Do not preserve or introduce compatibility bridges, migration shims, fallback paths, compact adapters, or dual behavior for old local states unless the user explicitly asks.
- Prefer: one canonical current-state codepath, fail-fast diagnostics, explicit recovery steps.
- Over: automatic migration, compatibility glue, silent fallbacks, "temporary" second paths.
- Default stance: delete old-state compatibility code rather than carry it forward.
- If temporary migration or compatibility code is introduced for debugging or a narrowly scoped transition, call it out in the same diff with: why it exists, why the canonical path is insufficient, exact deletion criteria, and the task that tracks its removal.

## Editing hygiene

On every edit, delete:

- Extra comments a human wouldn't add, or that are inconsistent with the rest of the file.
- Extra defensive checks or try/catch blocks that are abnormal for that area of the codebase, especially when the caller is a trusted / validated codepath.
- Casts to `any`.
- Any other style inconsistent with the file.

## Mistakes I have made

When the user is unhappy with a mistake, record it here in this same bullet style so it is not repeated.

- Re-ran a live interactive PTY test after the user had already declined it. Respect a rejection the first time.
- `installSupervisor` copied the running binary onto itself (`copyFileSync(self, target)` with `self === target`), truncating and destroying the installed binary. Guard self-referential file operations.
- `init` re-imported the "current account" from `~/.claude.json` `oauthAccount` and parked the live credential under it, assuming `oauthAccount` matches the live keychain credential. After swaps they diverge, so this clobbered a parked backup. Do not assume identity files agree with credential stores; make destructive commands idempotent and fail-fast on drift.
- Shipped the keychain write over `security -i` without verifying its line-buffer limit, then a real 4.3KB blob truncated silently. Verify external tool limits with a real-sized payload before relying on them.
- Installed the compiled binary by `copyFileSync` alone. macOS AMFI SIGKILLs (exit 137) a copied ad-hoc-signed Mach-O because the copy gets a `com.apple.provenance` xattr and the signature stops validating. After copying a Mach-O on macOS, `xattr -c` + `codesign --force --sign -` it. A byte-identical copy is not a runnable copy on macOS.
- Declared "no contamination" after seeing distinct parked-credential hashes and ~1-minute-different `/usage` reset clocks. Distinct blobs do not prove distinct accounts: two rotations of the SAME account's token differ byte-for-byte. Verify a credential's true owner via the roles endpoint (`fetchTokenOrg`), never by comparing blobs.
- `performSwap` harvested the live credential into whatever account `accounts.json` labeled active. Labels drift from the live blob (kill mid-swap before `saveAccounts`, manual `/login`), and one drifted harvest overwrote another account's backup, destroying its only credential. Park a credential under its token's API-reported identity, and commit the active label inside the same critical section as the credential writes.
