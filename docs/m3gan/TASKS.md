# M3GAN REAL tasks

The engineering backlog, in order. Each task names an owner, following the division of work in §161
of the master specification: Claude Code takes architecture, integration, documentation and
security review; Codex takes implementation, tests, adapters, schemas, migrations and CI. Either
agent may take any task when the other is not working; check `git status`, file modification times
and `M3GAN_STATUS.md` first so two agents never edit the same file at once (§162).

Status words: TODO, IN PROGRESS, DONE, BLOCKED.

## Now

| #   | Task                                                                                                                                                 | Owner  | Status      |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ----------- |
| 1   | Activate `lumina-cognitive-os` in the live gateway: allow list, config entry, build, restart, verify tools, the M3GAN tab and `/health`              | claude | IN PROGRESS |
| 21  | Recorder sessions (`recorder/recorder-store.ts`) still rewrite JSONL files; the database-first guard flags it. Move session metadata to SQLite state | codex  | TODO        |
| 22  | Translate the M3GAN tab: `pnpm ui:i18n:sync`. The catalog baseline already drifted before the tab existed                                            | codex  | TODO        |

## Next (v0.2 presence)

| #   | Task                                                                                                                    | Owner  | Status |
| --- | ----------------------------------------------------------------------------------------------------------------------- | ------ | ------ |
| 8   | Camera pipeline sidecar emitting `person.detected` and `world.observed`, gated by the camera privacy state              | codex  | TODO   |
| 9   | Authorized face recognition only for people whose consent says so; embeddings stored with the person, deleted on forget | codex  | TODO   |
| 10  | Speaker identification and diarization feeding `speech.recognized` with a speaker id and confidence                     | codex  | TODO   |
| 11  | Avatar expressions driven by the global workspace (presence, affect estimate, attention)                                | codex  | TODO   |
| 12  | Review of tasks 8 to 10 for consent, retention and the privacy states                                                   | claude | TODO   |

## Later (v0.3 autonomy, v0.4 simulation)

| #   | Task                                                                                                        | Owner  | Status |
| --- | ----------------------------------------------------------------------------------------------------------- | ------ | ------ |
| 13  | A reasoner that turns loop proposals into plans, still gated by the kernel and the autonomy level           | claude | TODO   |
| 14  | Reflection over the audit log and loop cycles that proposes lessons; never applies them by itself           | codex  | TODO   |
| 15  | ROS 2 bridge as a `BodyAdapter`, with the same intent contract and supervisor                               | codex  | TODO   |
| 16  | MuJoCo or Gazebo simulator adapter with a simulated camera and arm                                          | codex  | TODO   |
| 17  | External checkpoint for the audit chain (signed head hash outside the gateway) so tail deletion is detected | claude | TODO   |
| 18  | Physical confirmation channel (button or separate device) for physical actions                              | claude | TODO   |
| 19  | Evaluation suites for world model, social behavior and robot behavior in simulation (§137 to §141)          | codex  | TODO   |
| 20  | Benchmarks for loop latency and router throughput (§113)                                                    | codex  | TODO   |

## Done

| Task                                                                                                                         | Owner                      | Commit           |
| ---------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ---------------- |
| Cognitive core: router, attention, loop, workspace, self model, world model, body behind supervisor                          | claude                     | `280ea3593e4`    |
| Controller hardening, honest run-less actions, payload validation                                                            | codex                      | in `c4ead4d465e` |
| Safety kernel, SQLite persistence, privacy, brainstem, social layer, behaviors, HAL, dashboard                               | claude                     | `c4ead4d465e`    |
| One owner per tool name; live-only side effects; documentation                                                               | claude                     | `2017ac95e39`    |
| Tasks 2-5 and 7: durable goals, lessons and episodes; full forget-session; teleoperation; contracts split; delegation result | codex (finished by claude) | `7da8f6904dc`    |
| Durable stores open after activation (they were session-only live); network probe on PowerShell 5.1                          | claude                     | `7da8f6904dc`    |
| The M3GAN tab renders natively in the Control UI over `m3gan.*` gateway methods (ADR 0008)                                   | claude                     | this cycle       |
