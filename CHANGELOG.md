# Changelog

## 0.4.0 — 2026-11-10

Principle: what the plan says and how it is laid out is the model's own business; the plugin keeps the system around it (reading, saving, bringing it back, nudging the model to update).

- The prompt no longer gives a skeleton. It says what the plan is for (whoever picks the work up should be able to carry on from the plan alone), when to write and update it, that the user's latest words outrank older plan text, and how to save it. The six-part layout, the 「已作废」 section and the required user quotes are gone.
- `plan_write` no longer returns shape `hints`; nothing checks the plan's structure.
- New tool `plan_edit` (`{ old_string, new_string }` for one place, `{ edits: [...] }` for several): replaces the passages given and leaves the rest of the plan exactly as it is. All edits of a call become one version, or none is saved; each `old_string` must occur once. Same staleness and size rules as `plan_write`. Until now every update rewrote the whole plan: across 12 real sessions only about 27% of a plan's lines survived an update unchanged, and details the work still needed were dropped along the way.
- `plan_read({ version })` reads an earlier version back from the history.
- Reminder texts no longer refer to any layout.
- The prompt names what a reader must be able to learn from the plan alone: what the work is for, what the user decided (including where they corrected the model's understanding), where it stands and what comes next; the first two run through the whole job and are to be carried over when a new phase starts or the plan is rewritten. Without that sentence a DeepSeek run rewrote the plan at each new phase and kept only the current phase's requirements.

## 0.3.1 — 2026-11-09

- A session DSH copies into a new id — a branch ("在新对话中分支"), a move to another workspace — now inherits its parent's plan instead of starting over. The parent is found through the plan messages the copy inherited; the parent version the conversation showed is taken by hash from the parent's history (else the parent's current plan, noted as such) and saved as the copy's version 1 (`updatedBy: inherited`, `meta.inheritedFrom`). 0.3.0 posted "还没有计划" in such a copy, contradicting the plan still visible in its history.
- The "no plan yet" reminder is tracked per session, so a copy no longer inherits its parent's "already reminded".
- Progress reminder: when the plan has not changed for `staleSteps` steps (default 20; 0 = off), a short note asks what got done, what turned up and whether the next step changed, and to `plan_write` if anything did. At most once every `staleSteps` steps; a new version, or the change-of-mind reminder, restarts the count. Posted-plan placement only.
- Projection state v3 (adds `changedAt`, `nudgedAt`); older states are rebuilt from the session log.
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
