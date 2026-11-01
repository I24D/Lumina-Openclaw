# LUMINA STATUS

Live checkpoint for Lumina's cognitive core (§163 of the master specification). Every agent updates it
at the end of each significant cycle, so a new session can rebuild what exists, what works, what is
missing, what was in progress, what was decided and what blocks (§162). Details live in
`docs/lumina-core/`.

Updated: 2026-10-31 America/New_York, by Claude Code.

## CURRENT VERSION

- LUMINA CORE **0.1.0** (`LUMINA_CORE_VERSION` in `extensions/lumina-cognitive-os/src/cognition/plugin-wiring.ts`).
- OpenClaw base **2026.10.9** (merged from upstream `main` on 2026-10-31, `df63d26bd46`).
- Checkout: `openclaw-main`, branch `lumina/upstream-10.9` off `lumina/cognitive-core`, published
  to `I24D/Lumina-Openclaw` with `pnpm lumina:publish` (never a direct push: the grafted history
  cannot be uploaded).
- Code: `extensions/lumina-cognitive-os` (core), `extensions/lumina-context-engine` (guidance),
  `ui/src/pages/plugin/lumina-core-*.ts` (the native Lumina tab),
  `extensions/lumina-cognitive-os/src/mesh` (the Cognitive Mesh, see `MESH.md`).

## WORKING

Active in the live gateway since 2026-10-05 (`plugins.allow` + `plugins.entries`, body simulated
on MuJoCo, autonomy L3, owner Dal, camera and voice perception on, keyboard confirmation on).
Verified live on 2026-10-06 after the build of `e30c26c4450`: the webcam, microphone and
keyboard-confirmation sidecars run (`camera ok`, `microphone ok`, `physical-confirm ok`), and the
microphone already keeps an unknown voice anonymous; eight model files (FER, CED and Whisper among
them) match their pinned hashes; the persona probe reports version 1 of IDENTITY.md and SOUL.md;
`lumina.core.state` carries memory, persona and simulation training; the evaluation passes 40/40
live (core 15, failures 10, red team 10, endurance 4, performance: router about 56,000 events/s, a
cycle p95 0.02 ms); 132 `lumina_*` tools are in the agent's catalog, `lumina_causal` among them;
navigation training ran from the owner channel in 36 seconds and its policy was rejected (as many
goals, but two obstacle contacts against the default's one), so the simulated body keeps the
default, as designed. Only the audit-checkpoint probe is degraded, waiting for task 23. Verified by
tests: 623 cognitive-os and context-engine tests plus the Control UI tests; tsgo for extensions,
extension tests and the UI with 0 errors; oxlint, oxfmt, lit-analyzer and stylelint clean.

- Cognitive core: thalamic router with a privacy gate, attention queue with preemption, serial
  cognitive loop (untrusted events only proposed), global workspace, self model with the
  interaction mode among its limits.
- Situational reasoner: greets the owner, reports unknown people, low battery and subsystems down;
  asks about unknown things only with someone present (curiosity, `knowledge.gap`); companion
  check-ins. At L3 these reach the agent as proposals; at L4+ reversible ones run.
- Perception: webcam faces (YuNet + SFace), expressions (FER), objects and bodies (YOLOX, COCO)
  and microphone voices (Silero VAD + WeSpeaker), tone, sounds with hazards (CED mini) and
  speech-to-text on request (Whisper tiny), in Python sidecars, each running only while its
  privacy state is on; recognition and affect only with consent; unknown voices stay anonymous;
  objects become world sightings that affordances understand; bodies give the supervisor human
  zones even with no face in view.
- World model with affordances (what a thing lets you do, never a reason to do it), goals, lessons,
  episodic memory, recorder metadata, practice items and model hashes on SQLite plugin state.
- Safety kernel: invariants as code, authority hierarchy, a person's overrides (tools narrow,
  people widen), interaction modes as a separate restriction layer (ADR 0009), danger protocol,
  hash-chained audit log with external checkpoints, real-keyboard confirmation, safe state.
- Body: supervisor aware of people, pauses, modes, disabled capabilities, battery and affordances;
  behaviors, handover, teleoperation by role; symbolic robot, MuJoCo physics or ROS 2 (rosbridge).
- Learning: reflection proposes lessons a person accepts; practice book with spaced review,
  corrections and pronunciation feedback; a causal model keeps what Lumina's actions caused apart
  from correlations (`lumina_causal`); navigation learned only in simulation, used by the simulated
  body only once accepted on held-out rooms.
- Honesty and continuity: a reply that claims a physical action the body never ran goes back to
  the model; the identity files are versioned with a probe.
- Evaluation: core, failure-injection, red-team and endurance scenarios in sandboxes plus router
  and loop performance (`lumina_evaluate`).
- Provenance: perception models registered with source, licence, version, purpose and a pinned
  SHA-256, re-checked every 6 hours (`lumina_artifacts`).
- The Lumina tab renders natively in the Control UI over `lumina.core.*` gateway methods, with modes,
  sensors, evaluation, reflection, models, memory review and training in simulation.

## PARTIAL

- Child-mode content screening is a word list (English and Spanish), not a classifier; voice
  replies spoken live by Start Talk do not pass through it.
- The Lumina tab is in English and Spanish; the other 19 Control UI locales fall back to English
  until task 22 runs (a paid translation API, Dal's call).
- Conversation without internet needs a local language model; none is active on this machine.
- Backups: covered by `openclaw backup`; scheduling them is Dal's choice (archives hold credentials).
- Cognitive Mesh phase C: the TypeScript adapter over the fenced task RPCs is complete and
  tested, and TEST M2 now runs against a real PostgreSQL with the live function definitions
  replayed into it. What is missing is two OS processes racing: PGlite is a single in-process
  backend, so the two workers are two logical holders in a forced interleaving. `FOR UPDATE SKIP
  LOCKED` contention itself is upstream PostgreSQL behaviour and is not claimed as verified here.
- Cognitive Mesh phase F: the ICCV index is complete, with N/A for any component that has no
  denominator and a coverage figure beside every score. The Lumina tab does not show it yet;
  the order asked for instrumentation and a CLI first, a UI last.
- Cognitive Mesh transport proof: the Supabase transport and the task adapter are tested against
  recorded PostgREST shapes with an injected fetch. No test in this repository writes to the
  live Supabase project.

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

Nothing in software. What the section map still lists needs a robot (SLAM and depth, direction of
arrival, physical demonstration, a hardware watchdog, secure boot, a robot network) or is the
physical milestones v0.5 and v1.0. See `docs/lumina-core/SECTION_MAP.md` and `ROADMAP.md`.

## CURRENT TASK

Claude Code, 2026-11-01: the LUMINA Cognitive Mesh **runs in the production gateway**. The mesh is
`extensions/lumina-cognitive-os/src/mesh` with 294 tests across 12 files, and `MESH.md` is its map.
Codex and ChatGPT-LUMINA: no task open.

Phase 1 kept it deliberately unwired; Dal's production order of 2026-11-01 ended that. Proven on
the live instance, not in a harness:

- `[mesh] runtime started as openclaw-gateway; handlers=2` at 13:21:19, gateway PID 736.
- `GET /plugins/lumina-cognitive-os/mesh` (gateway auth) reports `running: true` with live counters.
- Two real rows were inserted into `lumina_events` and consumed: the first applied once, the second
  — a resend with a fresh `message_id` and the same `idempotency_key` — came back as
  `applied: 1, suppressedDuplicates: 1`. The effect ran once, which is the at-least-once contract
  holding in production.
- The inbound cursor persisted across a full gateway restart, so the first event was not replayed.

It needed no process of its own, which corrects the design note in `outbox.ts`: the host's retained
keyed store reaches SQLite through `observePluginStateInWorker`, so runtime SQL is already off the
Gateway main thread and `worker-access.md` is satisfied. What runs on the main thread is an `await`
and a `setTimeout`.

Task handoff is deliberately unregistered: it would consume the two RPCs whose defects are still
open. `LUMINA_MESH_ENABLED=0` is the kill switch.

## NEXT TASKS

1. Dal: approve or decline `sql/lumina_mesh_fence_hardening.sql`. It is the only open fix for two
   measured production defects, and applying DDL to the shared project is a red action.
2. Dal: approve or decline task 23 (the Supabase audit-checkpoint table).
3. Dal: decide on task 22 (translating the tab into 19 more locales with a paid API).
4. Any agent: the shared-memory audit reports four live inconsistencies it deliberately does not
   repair. Deciding what to do about ten half-superseded rows and the actor case collisions is a
   data decision, not a code one.
5. Dal: approve or decline `sql/lumina_mesh_finish_idempotent.sql` — the idempotent close on its
   own ("1B"), which the core LUMINA recommends and which changes no signature. The full hardening
   ("1A") needs `lumina_bus.py` updated in the same window and is a separate decision.
6. Any agent: keep the suites green; hardware work starts when a body exists.

## BLOCKERS

- No robot hardware: body paths are simulated.
- Two measured defects in the shared Supabase project stay open because fixing them is DDL:
  `lumina_finish_task`, `lumina_fail_task`, `lumina_start_task` and `lumina_heartbeat_task` take no
  fence token, so a zombie worker sharing an agent key can close a live attempt; and
  `lumina_finish_task_fenced` is not idempotent, so a repeated close overwrites a settled result
  and can flip its outcome. Both are reproduced and both fixes are proven in
  `extensions/lumina-cognitive-os/sql/m2-fencing.mjs`. Needs Dal (red action).
- The Supabase table for audit checkpoints needs Dal's approval (task 23).
- `pnpm ui:i18n:check` fails until the other locales are translated (task 22).
- A ChatGPT adapter that writes the bus unattended cannot be built: the only inbound route is the
  MCP server, which ChatGPT itself calls, and `lumina_events` is not in the Realtime publication.
  An API route would need spend and a credential Dal has not authorized.

## RECENT DECISIONS

ADRs in `docs/lumina-core/adr/`: 0001 build inside `lumina-cognitive-os`; 0002 safety is code; 0003
durable state in SQLite plugin state, opened only by the live gateway once its service starts;
0004 the owner's channel is the Control UI's Lumina tab; 0005 the model emits intents, never motor
commands; 0006 untrusted content never executes; 0007 one owner per tool name and side effects
only in the live gateway; 0008 the Lumina tab is a native Control UI view (no separate UI); 0009
interaction modes are a restriction layer, never written into a person's overrides; 0010 LUMINA is the
identity and the film M3GAN only the reference: the tab, methods, routes, docs and this file say
Lumina, while the durable stores keep their `m3gan.` namespaces so no state is lost; 0011 the mesh
delivers at least once beside the gateway, never exactly-once, and reuses the Supabase primitives
that already existed instead of reimplementing them.

## RECENT COMMITS

- `38a4c602888` consented face and voice recognition.
- `e42d1a75cc2` the mascot's face follows the situation.
- `19293e15a24` initiative within the autonomy level.
- `463d3bee4fb` audit checkpoints outside the process; real-keyboard confirmation.
- `98ced5fdc2f` reflection proposes lessons a person accepts.
- `1779e1c0fd2` MuJoCo body; `5f4774a60d6` and `fb7b1589394` ROS 2 adapter.
- `330026142e5` evaluation suite.
- `66c74d34954` recorder metadata in SQLite (ChatGPT-LUMINA, task 21).
- `d39b90eedee` Cognitive Mesh v1: envelope, outbox, inbox, dispatcher, authority, ICCV.
- `df63d26bd46` merge upstream `main` at 2026.10.9; six conflicts, no customization lost.
- `295d26681ee` TEST M2 on a real PostgreSQL: both fencing defects measured, both fixes proven.
- `6799d67541e` phase E: shared-memory dedup and supersession, event digests, ChatGPT adapter.
- `b490cfda215` interaction modes, curiosity, affordances, practice book and model provenance
  (with Codex's review of probes and affordances).
- `180a7c040bf` child-mode guard on the conversation hooks.
- `e79a086c918` Python sidecars run from the built gateway; the camera names objects (task 24).
- `a54459e6339` initiatives reach the owner's agent.
- `a5024f6c643` LUMINA is the identity; M3GAN only the reference (ADR 0010).
- `e30c26c4450` the software side of the specification is finished (tasks 25 and 27 among it).
