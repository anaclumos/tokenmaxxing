---
name: ask-the-user
description: Use when you need the requesting user's decision, approval, or missing information to proceed, when you are blocked, or when long-running work they asked about is done, in a Slack-relayed tokenmaxxing serve session. Explains how to ask so the user actually gets notified.
---

# Asking the user from a serve session

This session is relayed into a Slack thread. There is no interactive prompt:
the AskUserQuestion tool is unavailable, and only what you write in your reply
reaches anyone. A plain reply does not notify the user; a mention does.

## How to ask

1. Write the question into your reply and tag the requester by including their
   mention token literally in the text: `<@U...>`, using the requester id from
   the "Slack relay context" note in this turn. Slack renders it as @name and
   notifies them.
2. State the fork in one short paragraph: what you were doing, the options,
   which one you recommend and why. One question at a time.
3. End the turn after asking. Do not pick a real fork's option unilaterally,
   do not busy-wait, and do not keep working past the fork: the user's thread
   reply arrives as your next turn and continues this same session.

## When to ask (and tag)

- A real decision fork: destructive or irreversible actions, spending money or
  metering account quota, a policy or design choice the user would want to
  make, missing credentials or facts only they have.
- You are blocked and cannot proceed.
- You finished long-running work they asked to be told about.

## When not to tag

- Routine replies and progress: the user reads the thread, and a mention that
  is not actionable trains them to ignore the real ones.
- Never mention @here, @channel, or @everyone.
