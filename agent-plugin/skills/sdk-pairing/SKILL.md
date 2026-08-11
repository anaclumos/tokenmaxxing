---
name: sdk-pairing
description: Pair tokenmaxxing with the Claude Agent SDK (ensureBestAccount, pooledOptions, stopHookCheck). Use when building or debugging Bun agents that spawn Claude through the pooled credential store.
---

# SDK pairing

Import from the package root (`tokenmaxxing` → `src/sdk.ts`). Bun only.

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";
import { ensureBestAccount, pooledOptions, stopHookCheck } from "tokenmaxxing";

await ensureBestAccount();
for await (const message of query({
  prompt: "...",
  options: {
    ...pooledOptions(),
    hooks: { Stop: [{ hooks: [stopHookCheck] }] },
  },
})) {
  // capture session id from init for resume across swaps
}
```

## Rules

- Call `ensureBestAccount()` before each `query()` spawn (no mid-query hot-swap).
- `pooledOptions()` pins the real claude binary and a full replacement env with credential overrides scrubbed. It throws if `CLAUDE_CONFIG_DIR` or `CLAUDE_SECURESTORAGE_CONFIG_DIR` is set.
- `stopHookCheck` re-decides at turn boundaries; errors are swallowed so a broken check does not abort the turn.
- Own-accounts only (see terms docs). Offering pooled subscription logins to third parties is a ToS problem.

See [references/sdk.md](references/sdk.md).
