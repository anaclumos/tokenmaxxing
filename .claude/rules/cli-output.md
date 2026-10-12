---
paths:
  - "src/main.ts"
  - "src/cli/**"
---

# CLI output

`status`, `config`, and `check` have a text form and a `--json` form (`ok` mirrors exit 0, failures add `error`, progress on stderr only; contract in `docs/content/docs/commands.mdx`); every other command is text only and `main.ts` refuses the flag for it before dispatch (the CI smoke step parses `config --json`, the docs give `jq` recipes for the other two, and nothing consumes the rest). On those three, route every new success line through `emitJson` behind the `json` flag and every error through `emitError` (`notes` are text-only hints, `extra` is structured data). A bare `console.log` on a `--json`-capable command breaks the contract for scripts, and the text form must stay byte-identical: `status` renders from the same report the JSON prints, so change the collect step, not the renderer, when a number is wrong. Do not add `--json` to another command without a consumer.
