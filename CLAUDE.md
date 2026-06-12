# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

"Bound" (itch.io title: The Great Escape from the Gym) — a one-button horizontal-scrolling action game.
The entire game is a single dependency-free file: `index.html` (HTML5 Canvas + Web Audio, one IIFE).
There is no build step, no linter, and no test framework. UI text is bilingual (JP first, EN second);
code comments are Japanese; commit messages are English.

## Running and verifying

- Run: open `index.html` directly, or `npx serve .` (`.claude/launch.json` defines the
  `charge-runner` preview server on port 4455).
- Syntax check (no build means no compile errors — always do this before committing).
  PowerShell 5.1 misreads UTF-8 by default, so read explicitly:

  ```powershell
  $html = [System.IO.File]::ReadAllText("index.html", [System.Text.Encoding]::UTF8)
  $m = [regex]::Match($html, '(?s)<script>\s*(.*?)\s*</script>')
  [System.IO.File]::WriteAllText("$env:TEMP\check.js", $m.Groups[1].Value, (New-Object System.Text.UTF8Encoding $false))
  node --check "$env:TEMP\check.js"
  ```

- Behavior check: `requestAnimationFrame` pauses in background tabs, so `preview_screenshot`
  times out — don't rely on it. The proven workflow: temporarily add a `window.__t` hook at the
  bottom of the IIFE exposing closure internals (getters for `state`/`player`/`obstacles`/`charge`,
  `setHold()`, `press()`, and `step: n => { for (...) update(1/120); }`), drive the game with
  `preview_eval` step simulation, assert on numbers, then **remove the hook before committing**
  (grep for `__t` to confirm).
- Game state for manual testing lives in localStorage: `cr_bank` (star currency), `cr_skills`,
  `cr_bests` (per-stage), `cr_tut` (tutorial-done flag). `localStorage.clear()` simulates a
  first-time player (tutorial auto-runs). Note: skills bought during testing change physics —
  clear them before verifying vanilla behavior.

## Architecture of index.html

One IIFE with a fixed-timestep loop (`STEP = 1/120`). Sections appear in this order:
constants → skill/stage definitions + persistence → seeded RNG (mulberry32) → game state →
tutorial → stage generation → terrain queries → input/menu UI → update → collisions/die →
Web Audio synth → rendering → main loop.

State machine: `state` is `"title" | "skills" | "play" | "dead"`, plus `paused` (play only)
and `tut != null` (tutorial mode, overlays "play").

### Invariants that span multiple systems

- **Ghost trajectory generation**: a "ghost" bounces ahead of the player using the *same*
  physics and obstacles are placed to avoid its arcs, so the stage is always passable.
  Player physics and ghost generation share `effHeightPen()` / `effChargeTime()` /
  `effGlideFrac()` / `runSpeedAt()` — any change to player movement must flow through these
  shared helpers or generation becomes unfair/impossible.
- **Charge**: holding on ground glides at `jumpDist / effChargeTime` so a full charge travels
  exactly one normal-jump distance. Charge auto-releases at max and resets to 0 on every
  launch even if the button is still held (deliberate; do not reintroduce a "release first" lock).
- **Color phasing**: `o.color === player.ballColor` → pass through; white is solid to orange/black
  (the White Change skill lets the ball *become* white). Islands are inverted: a *different*
  color is landable, same color falls through.
- **Difficulty = reaction time, not pixels**: obstacle spacing is `runSpeedAt(x) × gapTime`,
  where gapTime shrinks 1.4s → 0.6s between 2000m and 6000m (`GAP_PHASE*_X`; 10 px = 1 m).
  Px-fixed spacing was removed on purpose.
- **Skills × stages**: stage configs override generation via `scN(key, default)`; skills live in
  the `skills` map (`1`=owned+on, `0`=owned+off — check with `hasSkill`/`skillOn`). Each stage's
  `req` skill gates its unlock, and stages are designed assuming that skill may be ON.
- **Coordinates**: world drawing happens inside
  `translate(sx, GROUND_SCREEN_Y); scale(ZOOM); translate(-cam, -GROUND_Y)`; HUD/menus draw in
  960×540 screen space afterwards. HiDPI scales only the canvas backing store at startup —
  all logic stays in 960×540.
- **Toasts/timers**: UI timing uses `performance.now()`, not game `time` (game time resets each
  run, which previously caused stuck toasts).

## Release

Public deploy is itch.io (`SHARE_URL` constant) via a zip of `index.html`
(e.g. `Compress-Archive index.html <name>.zip`; `*.zip` is gitignored). GitHub remote:
`Djuanabe/the-Great-Escape-from-the-Gym`. When asked to "push + re-zip", do both.
`screenshots/` is untracked and may be stale relative to current visuals.
