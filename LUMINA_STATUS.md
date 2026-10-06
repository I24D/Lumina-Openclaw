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

Claude Code: closing the software side of the specification (`e30c26c4450`): failure-injection,
red-team and endurance suites, memory review in the tab, honesty guard, persona ledger, causal
model, pronunciation feedback, sounds, tone, affect, human zones from the webcam and navigation
learned only in simulation. Codex and ChatGPT-LUMINA: no task open.

## NEXT TASKS

1. Dal: approve or decline task 23 (the Supabase audit-checkpoint table).
2. Dal: decide on task 22 (translating the tab into 19 more locales with a paid API).
3. Any agent: keep the suites green; hardware work starts when a body exists.

## BLOCKERS

- No robot hardware: body paths are simulated.
- The Supabase table for audit checkpoints needs Dal's approval (task 23).
- `pnpm ui:i18n:check` fails until the other locales are translated (task 22).

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
- `e30c26c4450` the software side of the specification is finished (tasks 25 and 27 among it).
