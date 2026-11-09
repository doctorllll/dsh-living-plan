# Changelog

## 0.3.1 — 2026-11-09

- A session DSH copies into a new id — a branch ("在新对话中分支"), a move to another workspace — now inherits its parent's plan instead of starting over. The parent is found through the plan messages the copy inherited; the parent version the conversation showed is taken by hash from the parent's history (else the parent's current plan, noted as such) and saved as the copy's version 1 (`updatedBy: inherited`, `meta.inheritedFrom`). 0.3.0 posted "还没有计划" in such a copy, contradicting the plan still visible in its history.
- The "no plan yet" reminder is tracked per session (projection state v2), so a copy no longer inherits its parent's "already reminded".
- The panel labels an inherited version 「从原会话带来」.

## 0.3.0 — 2026-11-09

Aim: through long sessions, repeated compaction and changes of mind, keep the model working towards what the user wants now.

- The plan is posted into the conversation as a `living-plan` message instead of living in the system prompt. It is posted when there is a new version (user edits included), when a compaction swallowed the last copy, and every `refreshSteps` steps (default 40). The system prompt keeps only the fixed contract, so saving a plan no longer rewrites the cached prompt prefix (measured on DSH 0.2.2-rc.1: the step after a plan change hit 94–98% of the cache, against 0–1% before).
- What was posted and whether a compaction swallowed it are folded from the session log through a `sessionProjections` cell, so restarts and resumes agree.
- User messages that a compaction replaced are posted with the plan verbatim (DSH's compaction summary paraphrases them in English).
- Reminders: when the user spoke and the plan has not moved for `remindAfterSteps` steps (default 3), and once when a session has no plan after `noPlanAfterSteps` steps (default 8).
- The writing contract gives a skeleton (the user's words quoted, goal and acceptance, decided, dropped, progress, next), puts the user's latest words above older plan text, and asks for an acceptance check before calling the work done. `plan_write` returns `hints` when the user quote or the acceptance criteria are missing.
- `placement: system` restores the 0.2.x behaviour without reinstalling.
- Fix: with no plan yet, the first `plan_write` is no longer refused as stale.
- Needs the `sessionProjections` service (DSH 0.2.2-rc.1 verified).

## 0.2.1 — 2026-11-06

- The panel follows the app theme: colours come from the client's design tokens (`--dsw-alias-*`), so it is legible in dark mode.
- Verified on DSH 0.2.2-rc.1.

## 0.2.0 — 2026-11-05

- Read-only 「计划」 panel in the web client's right sidebar, with version history; route `GET /api/living-plan`.
- PTC usage (`tools.plan_*` from `run_code`) documented and verified.

## 0.1.0 — 2026-11-05

- Versioned per-session living plan: `plan.md` at a fixed path, injected at every step, `plan_read` / `plan_write`, stale-write guard, user edits as new versions.
