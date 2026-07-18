---
name: usage-after-switch-live-observation
description: RESOLVED - user's live observation (in-session /usage flips account after xx switch on macOS) was correct and exposed a wrong verification; running sessions adopt external swaps in <=30s
metadata:
  type: project
---

User's Claim (2026-07-10): running /usage inside a live interactive session on the Mac, then `xx switch`, then /usage again showed the account changed live. RESOLVED same day by binary verification (workflow over the 2.1.206 bundle, adversarially judged): the observation was correct and generalizes - in-session /usage shares the inference token caches, and a per-request freshness poll adopts an external credential swap within ~30s (macOS raw keychain cache TTL) or immediately on Linux (mtime compare). The "no macOS hot-swap" paragraph previously in [[cc-codex-auth-mechanics]] was a verification error (mechanism present in 2.1.204/205/206 alike); it has been corrected there. Consequences recorded in that file: periodic switching is viable on both platforms, supervisor respawn is UX-only for Claude Code. Caveat worth remembering: a request already stuck in a 429 retry loop keeps its old token until that request dies; adoption lands on the session's NEXT request.
