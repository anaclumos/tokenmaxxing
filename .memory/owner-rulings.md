---
name: owner-rulings
description: Standing owner decisions that no code or doc shows - literal deletion scope, forks hold on silence, root cause before retries, Codex consults for open questions, subagent tiers, lowercase chart labels
metadata:
  type: feedback
---

- A destructive instruction authorizes exactly the nouns it names. "Delete the stale worktrees" covers worktrees, not their branches. Before a deletion pass, list the targets grouped by artifact kind, record every tip SHA, touch only the named kind, and offer the adjacent kinds as a question.
- A surfaced design fork holds until the owner picks. Silence never authorizes the stated lean, however clearly it was stated. Only in-plan actions continue meanwhile: retrying the same named mechanism, cancelling dead tasks, watching state.
- A retry budget or a try/catch around an unexplained failure is monkeypatching. Identify the mechanism that produces the symptom, fix that layer, and only then decide whether a bounded retry is warranted for transient residue. One structural error boundary beats per-site catches.
- An open design or scoping question is decided by a Codex consult when the owner names one ("codex:rescue"): a headless `codex exec --skip-git-repo-check -s read-only -c model_reasoning_effort=high -C <dir> -o <file> "<prompt>"` from the repo, or a tmux question-and-answer session. It meters the owner's Codex quota, so one consult per question, the owner naming it is the spend mandate, and the verdict goes in the PR body.
- Research and verification subagents run on Opus or Sonnet, in small fan-outs. Fable is for one small hardest-judgment stage, and a wide Fable fan-out is asked about first, because the dev hosts are logged in with the pooled accounts.
- Every `status` chart label is lowercase: `5h`, `week`, and short family names such as `fable`, `spark`, `rsrv`. Titlecase is barred.
- Features over docs: an English change ships on its own, and a localized sync follows.
