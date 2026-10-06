# LUMINA STATUS

Live checkpoint for Lumina's cognitive core (§163 of the master specification). Every agent updates it
at the end of each significant cycle, so a new session can rebuild what exists, what works, what is
missing, what was in progress, what was decided and what blocks (§162). Details live in
`docs/lumina-core/`.

Updated: 2026-10-06 America/New_York, by Claude Code.

## CURRENT VERSION

- LUMINA CORE **0.1.0** (`LUMINA_CORE_VERSION` in `extensions/lumina-cognitive-os/src/cognition/plugin-wiring.ts`).
- Checkout: `openclaw-main`, branch `lumina/cognitive-core`, published to `I24D/Lumina-Openclaw`.
- Code: `extensions/lumina-cognitive-os` (core), `extensions/lumina-context-engine` (guidance),
  `ui/src/pages/plugin/lumina-core-*.ts` (the native Lumina tab).

## WORKING

Active in the live gateway since 2026-10-05 (`plugins.allow` + `plugins.entries`, body simulated
on MuJoCo, autonomy L3, owner Dal, camera and voice perception on, keyboard confirmation on).
Verified live on 2026-10-06 after the last build: the webcam, microphone and keyboard-confirmation
sidecars run (`camera ok`, `microphone ok`, `physical-confirm ok`); five model files match their
pinned hashes; `lumina.core.mode` switches child mode on and off from the owner channel with the self
model, restrictions, audit and guardian summary following; the evaluation suite passes 16/16 live
(router about 97,000 events/s, a cycle p95 0.02 ms); 131 `lumina_*` tools are in the agent's
catalog, including `lumina_mode`, `lumina_practice` and `lumina_artifacts`; initiatives queue for
the owner's agent without errors (outside the 11:00 to 23:00 heartbeat window they wait for the
next turn). Only the audit-checkpoint probe is degraded, waiting for task 23. Verified by tests:
599 cognitive-os tests plus the context-engine and Control UI tests; tsgo for extensions,
extension tests and the UI with 0 errors; oxlint, oxfmt and lit-analyzer clean.

- Cognitive core: thalamic router with a privacy gate, attention queue with preemption, serial
  cognitive loop (untrusted events only proposed), global workspace, self model with the
  interaction mode among its limits.
- Situational reasoner: greets the owner, reports unknown people, low battery and subsystems down;
  asks about unknown things only with someone present (curiosity, `knowledge.gap`); companion
  check-ins. At L3 these reach the agent as proposals; at L4+ reversible ones run.
- Perception: webcam faces (YuNet + SFace) and objects (YOLOX, COCO) and microphone voices
  (Silero VAD + WeSpeaker) in Python sidecars, each running only while its privacy state is on;
  recognition only with consent; objects become world sightings that affordances understand.
- World model with affordances (what a thing lets you do, never a reason to do it), goals, lessons,
  episodic memory, recorder metadata, practice items and model hashes on SQLite plugin state.
- Safety kernel: invariants as code, authority hierarchy, a person's overrides (tools narrow,
  people widen), interaction modes as a separate restriction layer (ADR 0009), danger protocol,
  hash-chained audit log with external checkpoints, real-keyboard confirmation, safe state.
- Body: supervisor aware of people, pauses, modes, disabled capabilities, battery and affordances;
  behaviors, handover, teleoperation by role; symbolic robot, MuJoCo physics or ROS 2 (rosbridge).
- Learning: reflection proposes lessons a person accepts; practice book with spaced review and
  corrections for teaching and languages.
- Evaluation: 15 sandboxed scenarios plus router and loop performance (`lumina_evaluate`).
- Provenance: perception models registered with source, licence, version, purpose and a pinned
  SHA-256, re-checked every 6 hours (`lumina_artifacts`).
- The Lumina tab renders natively in the Control UI over `lumina.core.*` gateway methods, with modes,
  sensors, evaluation, reflection and models.

## PARTIAL

- Pronunciation is judged by the agent from what it heard; no acoustic scoring.
- Child-mode content screening is a word list (English and Spanish), not a classifier; voice
  replies spoken live by Start Talk do not pass through it.
- The Lumina tab is in English for other locales until `pnpm ui:i18n:sync` runs (task 22).
- Backups: covered by `openclaw backup`; scheduling them is Dal's choice (archives hold credentials).

## BROKEN

Nothing known. Fixed this cycle: no Python sidecar of the plugin could start from the built
gateway (the bundle looked for `dist/sidecars`, which never existed), so the webcam, microphone,
keyboard confirmation, MuJoCo body, wake word, recorder and code runner were dead in production and
the confirmation probe still said ready; the sidecars now ship next to the bundle, a failing one
backs off instead of respawning every second, and its last stderr line explains why. No initiative
had ever reached the agent either: with several agents configured, the bare `main` session key is
ambiguous, so every one was refused; they now go to the owner's agent by its full key
(`ownerAgentId`, default `main`). Also: the self model reported the microphone as never connected and the
camera as available only with a simulated robot, although the recognizing sensors were running;
Codex found that core probes called a missing, stale or future snapshot healthy and that a person
could be given an object's affordances through a label; a draft of the interaction modes would
have re-enabled a capability a person switched off during the mode.

## PLANNED

Reinforcement learning in simulation only (task 25) and acoustic pronunciation scoring (task 27). Hardware is not available
(MOCK and INTERFACE ONLY where it applies). See `docs/lumina-core/TASKS.md` and `docs/lumina-core/ROADMAP.md`.

## CURRENT TASK

Claude Code: this cycle is built, verified live and published, including the identity rename
(ADR 0010): `lumina.core.state` answers, the old `m3gan.*` methods are gone, `/plugins/lumina-cognitive-os/core/health`
responds and the audit chain kept its entries across the rename.
ChatGPT-LUMINA: task 22 (translations). Task 21 is done (`66c74d34954`).

## NEXT TASKS

1. Dal: approve or decline task 23 (the Supabase audit-checkpoint table).
2. Codex: tasks 25 and 27 in `docs/lumina-core/TASKS.md`.
3. Claude Code: the next open item in the section map.

## BLOCKERS

- No robot hardware: body paths are simulated.
- The Supabase table for audit checkpoints needs Dal's approval (task 23).
- The Control UI translation baseline already drifted before the Lumina tab (`pnpm ui:i18n:check`).

## RECENT DECISIONS

ADRs in `docs/lumina-core/adr/`: 0001 build inside `lumina-cognitive-os`; 0002 safety is code; 0003
durable state in SQLite plugin state, opened only by the live gateway once its service starts;
0004 the owner's channel is the Control UI's Lumina tab; 0005 the model emits intents, never motor
commands; 0006 untrusted content never executes; 0007 one owner per tool name and side effects
only in the live gateway; 0008 the Lumina tab is a native Control UI view (no separate UI); 0009
interaction modes are a restriction layer, never written into a person's overrides; 0010 LUMINA is the
identity and the film M3GAN only the reference: the tab, methods, routes, docs and this file say
Lumina, while the durable stores keep their `m3gan.` namespaces so no state is lost.

## RECENT COMMITS

- `38a4c602888` consented face and voice recognition.
- `e42d1a75cc2` the mascot's face follows the situation.
- `19293e15a24` initiative within the autonomy level.
- `463d3bee4fb` audit checkpoints outside the process; real-keyboard confirmation.
- `98ced5fdc2f` reflection proposes lessons a person accepts.
- `1779e1c0fd2` MuJoCo body; `5f4774a60d6` and `fb7b1589394` ROS 2 adapter.
- `330026142e5` evaluation suite.
- `66c74d34954` recorder metadata in SQLite (ChatGPT-LUMINA, task 21).
- `b490cfda215` interaction modes, curiosity, affordances, practice book and model provenance
  (with Codex's review of probes and affordances).
- `180a7c040bf` child-mode guard on the conversation hooks.
- `e79a086c918` Python sidecars run from the built gateway; the camera names objects (task 24).
- `a54459e6339` initiatives reach the owner's agent.
- `a5024f6c643` LUMINA is the identity; M3GAN only the reference (ADR 0010).
