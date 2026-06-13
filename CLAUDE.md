# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

"Bound" (itch.io title: The Great Escape from the Gym) — a one-button horizontal-scrolling action game.
Dependency-free, no build step / linter / test framework. UI text is bilingual (JP first, EN second);
code comments are Japanese; commit messages are English.

Files (HTML5 Canvas + Web Audio, plain `<script>` tags — no modules, so `file://` works):
- `engine.js` — shared `window.Bound` namespace: physics/geometry constants, `PHYS_BASE`, pure
  functions (`mulberry32`, `roundRect`, `moverGap`, `runSpeedAt`, `holeAt`, `landableAt`) and all
  draw primitives (ground/hole/island/obstacles/items/ball). **Both the game and the editor render
  and simulate through this**, so the editor's playtest is physics-identical to the game. Changes to
  movement math or visuals belong here.
- `index.html` + `style.css` + `game.js` — the game (one IIFE in game.js). Loads engine.js then game.js.
- `editor.html` + `editor.css` + `editor.js` — the stage editor (one IIFE). Loads engine.js then editor.js.

game.js / editor.js keep thin local wrappers (e.g. `function drawObstacles(camX){ Bound.drawObstacles(...) }`,
`function holeAt(x){ return Bound.holeAt(obstacles,x) }`) so call sites stay readable while the
implementation lives once in engine.js. Constants are pulled in via `const { GROUND_Y, ... } = Bound;`.

## Running and verifying

- Run: open `index.html` directly, or `npx serve .` (`.claude/launch.json` defines the
  `charge-runner` preview server on port 4455).
- Syntax check (no build means no compile errors — always do this before committing). The JS now
  lives in standalone files, so check them directly: `node --check engine.js game.js editor.js`.
- Behavior check: `requestAnimationFrame` pauses in background tabs, so `preview_screenshot`
  times out — don't rely on it. The proven workflow: temporarily add a `window.__t` hook at the
  bottom of game.js's IIFE exposing closure internals (getters for `state`/`player`/`obstacles`/`charge`,
  `setHold()`, `press()`, `draw`, and `step: n => { for (...) update(1/120); }`), drive the game with
  `preview_eval` step simulation, assert on numbers, then **remove the hook before committing**
  (grep for `__t`/`__e` to confirm). To verify a render change without a screenshot, call the exposed
  `draw()` then read pixels with `getImageData` (multiply logical coords by `devicePixelRatio`).
  When refactoring physics, capture golden numbers first (`runSpeedAt`, full-charge `vy`/`vx`,
  `moverGap` at a fixed `time`, `holeAt`/`landableAt`) and re-assert them identical afterward.
- Game state for manual testing lives in localStorage: `cr_bank` (star currency), `cr_skills`,
  `cr_bests` (per-stage), `cr_tut` (tutorial-done flag). `localStorage.clear()` simulates a
  first-time player (tutorial auto-runs). Note: skills bought during testing change physics —
  clear them before verifying vanilla behavior.

## Architecture of game.js

One IIFE with a fixed-timestep loop (`STEP = 1/120`). Sections appear in this order:
constants (pulled from `Bound`) → skill/stage definitions + persistence + custom-stage loader →
game state → tutorial → stage generation → terrain queries (thin `Bound` wrappers) →
input/menu UI → update → collisions/die → Web Audio synth → rendering (thin `Bound` wrappers) →
main loop. Shared constants/physics/draw live in engine.js (see Files above).

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

Public deploy is itch.io (`SHARE_URL` constant in game.js). The game is now multi-file, so the zip
must include all of them: `Compress-Archive index.html,style.css,engine.js,game.js <name>.zip`
(add `editor.html,editor.css,editor.js` only if you want to ship the editor too — usually not).
`*.zip` is gitignored. GitHub remote: `Djuanabe/the-Great-Escape-from-the-Gym`. When asked to
"push + re-zip", do both. `screenshots/` is untracked and may be stale relative to current visuals.
