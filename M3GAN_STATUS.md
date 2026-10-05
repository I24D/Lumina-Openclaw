# M3GAN STATUS

Live checkpoint for Project M3GAN REAL (§163 of the master specification). Every agent updates it
at the end of each significant cycle, so a new session can rebuild what exists, what works, what is
missing, what was in progress, what was decided and what blocks (§162). Details live in
`docs/m3gan/`.

Updated: 2026-10-05 11:45 America/New_York, by Claude Code.

## CURRENT VERSION

- M3GAN CORE **0.1.0** (`M3GAN_CORE_VERSION` in `extensions/lumina-cognitive-os/src/cognition/plugin-wiring.ts`).
- Checkout: `openclaw-main`, branch `lumina/cognitive-core`, published to `I24D/Lumina-Openclaw`.
- Code: `extensions/lumina-cognitive-os` (core), `extensions/lumina-context-engine` (guidance),
  `ui/src/pages/plugin/m3gan-*.ts` (the native M3GAN tab).

## WORKING

Active in the live gateway since 2026-10-05 (`plugins.allow` + `plugins.entries`, body simulated,
autonomy L3, owner Dal). Verified live at 11:45: the plugin loads at startup, durable state
survives restarts (the audit chain kept growing across three restarts, 9 entries, intact),
`m3gan.state` answers over the gateway, `/health` reports `ok` with every probe green (network
online, battery charging at 100%), and `lumina_plan_run` with 126 `lumina_*` tools is in the
agent's catalog. Verified by tests: 532 passing across the cognitive-os, context-engine and
supabase suites, plus the Control UI tests; tsgo for extensions, extension tests and the UI with 0
errors; oxlint, oxfmt, stylelint and lit-analyzer clean.

- Cognitive core: thalamic router with a privacy gate, attention queue with preemption, serial
  cognitive loop (untrusted events only proposed), global workspace, self model.
- World model, goals, lessons and episodic memory on SQLite plugin state.
- Safety kernel: invariants as code, authority hierarchy, human overrides (tools narrow, people
  widen), danger protocol, hash-chained audit log, safe state.
- Privacy states, brainstem (8 probes, energy policy), people with roles and consent, presence,
  theory of mind and affect estimates, consolidation on a timer.
- Body: supervisor aware of people, pauses, disabled capabilities and battery; behaviors, handover
  protocol, `predict()`, teleoperation by role; all against the simulated desktop robot (MOCK).
- Plans: `lumina_action_plan` validates hierarchical plans, `lumina_plan_run` walks them step by
  step under the safety gate with ordered rollback.
- The M3GAN tab renders natively in the Control UI over `m3gan.*` gateway methods.

## PARTIAL

- People are remembered without face or voice recognition; no camera pipeline into the core.
- The M3GAN tab is in English for other locales until `pnpm ui:i18n:sync` runs (task 22).
- Recorder sessions still rewrite JSONL files (task 21).

## BROKEN

Nothing known in the M3GAN code. Fixed this cycle: durable stores opened during registration were
session-only in production; every awareness query failed on Windows PowerShell 5.1 (leading pipe),
so battery, network, disks, devices, GPU and monitors were empty and the brainstem reported the
machine offline; plan ids collided within one millisecond; `lumina_whatsapp_respond` had no
manifest contract and was dropped.

## PLANNED

Camera pipeline and authorized recognition, speaker identification, avatar from the workspace, a
reasoner over loop proposals, reflection, ROS 2 bridge, physics simulator, external audit
checkpoint, physical confirmation channel, evaluation suites, benchmarks. Hardware is not available
(MOCK and INTERFACE ONLY where it applies). See `docs/m3gan/TASKS.md` and `docs/m3gan/ROADMAP.md`.

## CURRENT TASK

None in progress. Deployed and verified; reload the Control UI browser tab once to load the new
UI build with the M3GAN tab.

## NEXT TASKS

1. Codex: tasks 8 to 11, 14 to 16, 19 to 22 in `docs/m3gan/TASKS.md`.
2. Claude Code: tasks 12, 13, 17 and 18, and review of Codex's work.

## BLOCKERS

- No robot hardware: body paths are simulated.
- The Control UI translation baseline already drifted before M3GAN (`pnpm ui:i18n:check`).

## RECENT DECISIONS

ADRs in `docs/m3gan/adr/`: 0001 build inside `lumina-cognitive-os`; 0002 safety is code; 0003
durable state in SQLite plugin state, opened only by the live gateway once its service starts;
0004 the owner's channel is the Control UI's M3GAN tab; 0005 the model emits intents, never motor
commands; 0006 untrusted content never executes; 0007 one owner per tool name and side effects
only in the live gateway; 0008 the M3GAN tab is a native Control UI view (no separate UI).

## RECENT COMMITS

- `280ea3593e4` feat(lumina-cognitive-os): M3GAN REAL cognitive core.
- `c4ead4d465e` safety kernel, persistence, social and body layers (with Codex's controller work).
- `2017ac95e39` docs, one owner per tool, live-only side effects.
- `7da8f6904dc` durable goals, lessons and episodes; teleoperation; stores open after activation
  (finishes Codex's tasks 2 to 5 and 7).
- `51cc0c47a2a` native M3GAN tab in the Control UI over gateway methods.
- `8adbc15e15f` plan walk; awareness on Windows PowerShell 5.1.
