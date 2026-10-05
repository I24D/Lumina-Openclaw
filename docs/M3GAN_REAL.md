# M3GAN REAL — engineering map

M3GAN REAL is the embodied, multimodal, persistent agent described in Dal Nijaruq's master
specification. It is built on LUMINA, not beside it: LUMINA stays the identity, memory and
orchestration layer, and the models (OpenAI, Claude, Gemini, GLM, local) stay replaceable engines.

This page maps every section of the specification to the code that implements it, so Claude
Code, Codex and contributors extend what exists instead of writing it twice. Section numbers
(§) refer to the specification.

## Where the code lives

Everything below is in the `lumina-cognitive-os` extension, under
`extensions/lumina-cognitive-os/src/`:

| Directory     | Role                                                                  |
| ------------- | --------------------------------------------------------------------- |
| `cognition/`  | Attention, router, loop, workspace, self model, autonomy, uncertainty |
| `world/`      | World model and the perception hook that feeds it                     |
| `embodiment/` | Body contract, safety supervisor, embodied controller                 |
| `memory/`     | Working and episodic memory                                           |
| `awareness/`  | Environment sensing (battery, network, disks, devices, monitors)      |

`cognition/cognitive-runtime.ts` assembles the core; `cognition/plugin-wiring.ts` starts it from
the plugin entry. The data flow:

```
awareness bus ──┐
perception ─────┼─▶ thalamic router ─┬─▶ world model        (every event)
agent tools ────┘                    └─▶ attention queue ─▶ cognitive loop
                                                               │
goals, lessons, working memory, environment, self ──▶ global workspace

agent / loop ─▶ embodied controller ─▶ safety supervisor ─▶ body adapter
```

## Status by section

**Built** means implemented and tested. **Partial** means a real piece exists and the gap is
named. **Missing** means nothing exists yet. **Hardware** means it needs a body or a simulator
before it can be more than an interface.

| §     | Piece                                                       | Status   | Code / gap                                                                                                                                               |
| ----- | ----------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Shared memory, replaceable models                           | Built    | Supabase `shared_memory`, `memory-wiki`, `lumina-supabase`; models are OpenClaw providers                                                                |
| 3.1   | Brainstem                                                   | Partial  | Awareness poller and the kill switch exist. Missing: a watchdog that runs when the model is down, and an explicit safe state                             |
| 3.2   | Salience, attention queue                                   | Built    | `cognition/attention.ts`, `cognition/attention-queue.ts` (priority queue, emergency and margin-based preemption)                                         |
| 3.3   | Thalamic router                                             | Built    | `cognition/router/thalamic-router.ts`. In-process; a NATS/MQTT/ROS 2 transport can sit behind `ingest()`                                                 |
| 3.4   | Model router with fallback                                  | Built    | OpenClaw model fallbacks and `operator/brain-multi.ts`. Not duplicated here                                                                              |
| 3.5   | Global workspace                                            | Built    | `cognition/workspace/global-workspace.ts`; tool `lumina_workspace`                                                                                       |
| 4.1   | Working memory                                              | Built    | `memory/working-memory.ts`                                                                                                                               |
| 4.2   | Episodic memory                                             | Built    | `memory/episodic-memory.ts`                                                                                                                              |
| 4.3   | Semantic memory                                             | Partial  | Supabase `shared_memory`, memory wiki, `cognition/learning/lessons.ts`                                                                                   |
| 4.4   | Relational memory                                           | Partial  | People are world-model entities with relations. Missing: consented face/voice embeddings                                                                 |
| 4.5   | Procedural memory                                           | Built    | `skills/` (loader, runner, evaluation, learning from a recording)                                                                                        |
| 4.6   | Consolidation                                               | Missing  | Episodes are never clustered into semantic knowledge yet                                                                                                 |
| 5     | World model                                                 | Built    | `world/world-model.ts`; tools `lumina_world_observe`, `lumina_world_query`                                                                               |
| 6     | Spatial intelligence                                        | Partial  | Symbolic semantic map (places, `on_top_of`, `in_front_of`...). Metric map, SLAM and topological map need a body                                          |
| 7     | Vision                                                      | Partial  | Screen vision (UI Automation, OmniParser, `sight`). Camera pipeline missing; its event contract (`world.observed`) is ready                              |
| 8     | Audition                                                    | Partial  | Wake word and speech-to-text. Missing: diarization, speaker identification, direction of arrival                                                         |
| 9     | Voice                                                       | Built    | Start Talk on Gemini Live with barge-in                                                                                                                  |
| 10    | Affective perception                                        | Missing  |                                                                                                                                                          |
| 11    | Personality                                                 | Partial  | `lumina_identity` in Supabase. Missing: a versioned local profile the core reads                                                                         |
| 12    | Self model                                                  | Built    | `cognition/self/self-model.ts`; tool `lumina_self_model`                                                                                                 |
| 13    | Theory of mind                                              | Missing  |                                                                                                                                                          |
| 14    | Reasoning pipeline                                          | Built    | `cognition/loop/cognitive-loop.ts`, serial with preemption. The default reasoner is observe-only (see below)                                             |
| 15    | Planner                                                     | Partial  | `action/planner.ts` validates step plans. Missing: hierarchical goals with preconditions and rollback                                                    |
| 16    | Internal simulation                                         | Partial  | `SimulatedBody` exercises the body path symbolically. Missing: `predict(action, world)` and a physics simulator bridge                                   |
| 17    | Reflection                                                  | Partial  | `cognition/learning/lessons.ts` keeps confidence-weighted lessons per event kind                                                                         |
| 18    | Uncertainty                                                 | Built    | `cognition/uncertainty.ts`: physical thresholds, verify / observe_more / ask / abstain, and a ceiling on non-sensor evidence                             |
| 19    | Tool registry                                               | Built    | OpenClaw tool registry; every tool is declared in the plugin manifest                                                                                    |
| 20    | Capability permissions                                      | Built    | Digital: `governance/governance-policy.ts`. Body: capabilities granted only in plugin config (`grantedCapabilities`)                                     |
| 21    | Digital autonomy, traceability                              | Built    | PC and browser tools, `transparency/`, action log; body requests are logged to the transparency panel                                                    |
| 22    | Agent orchestration                                         | Partial  | `agents/director.ts`, Supabase `lumina_tasks`. Missing: the uniform delegation result (task, status, evidence, errors)                                   |
| 23    | Embodied layer                                              | Built    | `embodiment/`: intents only, safety supervisor, body adapters; tool `lumina_body`                                                                        |
| 24    | ROS 2                                                       | Hardware | A ROS 2 adapter implements `BodyAdapter`                                                                                                                 |
| 25–31 | Locomotion, arms, hands, head, proprioception, touch, smell | Hardware | Covered at the intent level (`navigate_to`, `grasp`, `look_at`...); everything below the intent needs a body or simulator                                |
| 32    | Energy management                                           | Partial  | Battery is in awareness and the self model. Missing: the go-charge behavior                                                                              |
| 33    | Autonomy levels                                             | Built    | `cognition/autonomy-levels.ts`, applied to the body as well                                                                                              |
| 34    | Behavior engine                                             | Missing  | Body intents are the primitives behaviors will compose                                                                                                   |
| 35    | Skill system                                                | Built    | `skills/`                                                                                                                                                |
| 36–39 | Learning                                                    | Partial  | Immediate learning through `lumina_world_observe`; demonstration through `skill-from-recording`; asking is the `ask` resolution. Missing: habit learning |
| 40    | Social intelligence                                         | Missing  |                                                                                                                                                          |
| 41    | Child interaction mode                                      | Missing  | The specification received so far ends partway through this section                                                                                      |

## Safety properties

These hold today and are covered by tests. Changes must keep them.

- **The language model never drives a motor.** Cognition can only emit `BodyIntent`s. Trajectories,
  joint targets and motor commands live behind `BodyAdapter`, out of the model's reach.
- **Every check only narrows.** The safety supervisor, like `decideAutonomy`, can turn "allow" into
  "confirm" or "deny" and never the reverse.
- **Stopping always works.** `stop` is allowed with the emergency stop engaged, without a body and
  without any grant. Engaging the kill switch halts the body at once.
- **The model cannot grant itself anything.** Body capabilities, pre-authorizations and the autonomy
  level come from the plugin config, which no tool writes. There is no model-settable confirmation flag.
- **Uncertain beliefs do not move a body.** Physical intents use stricter thresholds (act above 0.95,
  verify from 0.85). A borderline belief is verified first, even when pre-authorized.
- **Hearsay is not evidence.** Anything not from a sensor is capped at 0.9 confidence, below the
  physical threshold, so a claim alone can never drive a body. A claim also never lowers a belief a
  sensor already backs.
- **Grasping and handing objects to people always ask**, at every level.
- **Nothing claims consciousness.** The self model states functional states only.
- **Nothing is silently deleted.** The world model is event-sourced; beliefs decay but stay on record.

## Running it

The extension is off by default. To enable it, add `lumina-cognitive-os` to `plugins.allow` and give
it an entry in `openclaw.json`. Enabling it registers every tool in the extension, not only the
cognitive core, so review its manifest first.

```json
{
  "plugins": {
    "entries": {
      "lumina-cognitive-os": {
        "enabled": true,
        "config": {
          "autonomyLevel": 3,
          "bodyMode": "none",
          "grantedCapabilities": [],
          "preAuthorizedCapabilities": []
        }
      }
    }
  }
}
```

- `autonomyLevel` (0–5, default 3) caps initiative. L3 notices and proposes but asks first.
- `bodyMode` is `none` on a desktop (every physical intent is refused) or `simulated`.
- `grantedCapabilities` lists the body capabilities Dal allows: `robot.look`, `robot.gesture`,
  `robot.navigate`, `robot.grasp`, `robot.handover`.
- `preAuthorizedCapabilities` lists granted ones that may run without asking at L4 and above, only
  when reversible and low risk.
- `cognitiveCoreEnabled: false` turns the core off and keeps the rest of the extension.

The loop starts observe-only: it routes events, keeps the world model and workspace current, and
records what lessons apply, but it proposes no actions. A reasoner that proposes actions is a
separate, deliberate step (next phase).

## Known debt

- Two risk vocabularies coexist: `risk/policies.ts` (`SAFE`, `WARNING`, `HIGH_RISK`, `CRITICAL`) and
  `governance/governance-policy.ts` (`SAFE`, `LOW`, `MEDIUM`, `HIGH`, `CRITICAL`). The governance scale
  is also the format of `governance-policy.json`, so merging them is a migration, not a rename.
- The extension imports agent tool helpers from core `src/` through `shared/tool-result.ts`, outside
  the plugin SDK boundary. New code goes through that one file so the boundary moves in one place.

## Next phases

1. **Memory and minds (software only):** consolidation (§4.6), consented relational memory (§4.4),
   theory of mind with explicit uncertainty (§13), affective estimates (§10).
2. **Acting:** a reasoner that proposes actions through the existing gates, a hierarchical planner
   with preconditions and rollback (§15), `predict()` (§16), the behavior engine (§34) and the
   energy manager's go-charge behavior (§32).
3. **Simulation:** a MuJoCo or Isaac Sim bridge as a `BodyAdapter`, then a ROS 2 adapter and a
   network transport behind the router.
4. **Hardware:** the physical body, starting without legs (§25).
