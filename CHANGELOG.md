# Changelog

## 0.2.1 — 2026-11-06

- The panel follows the app theme: colours come from the client's design tokens (`--dsw-alias-*`), so it is legible in dark mode.
- Verified on DSH 0.2.2-rc.1.

## 0.2.0 — 2026-11-05

- Read-only 「计划」 panel in the web client's right sidebar, with version history; route `GET /api/living-plan`.
- PTC usage (`tools.plan_*` from `run_code`) documented and verified.

## 0.1.0 — 2026-11-05

- Versioned per-session living plan: `plan.md` at a fixed path, injected at every step, `plan_read` / `plan_write`, stale-write guard, user edits as new versions.
