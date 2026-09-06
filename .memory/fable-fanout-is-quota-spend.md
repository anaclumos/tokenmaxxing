---
name: fable-fanout-is-quota-spend
description: Owner correction 2026-08-30 - never put Fable on wide agent fan-outs; it drains the live pooled quota this tool manages
metadata:
  type: feedback
---

Owner (2026-08-30): "Don't spam fable like that", after an adversarial review workflow ran finder and refuter agents on Fable at wide fan-out. Development happens on hosts whose Claude logins are the same pooled accounts tokenmaxxing manages, so every Fable agent burns the owner's real Fable weekly cap; the panel drained it mid-run (28 of 40 agents died on the limit) and tripped the very switch machinery under test.

**Why:** Fable-tier fan-out here is not free compute, it is metered spend against the owner's live accounts, the same class as `status --ping` under [[live-pool-runs-need-permission]].

**How to apply:** Reserve Fable for at most one small, hardest-judgment stage (final verify or judge, minimal agent count). Finders, scanners, and drafting stages run opus or sonnet. Before launching any workflow whose Fable agent count is more than a couple, treat it as spend and ask first.
