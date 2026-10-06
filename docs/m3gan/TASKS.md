# M3GAN REAL tasks

The engineering backlog, in order. Each task names an owner, following the division of work in §161
of the master specification: Claude Code takes architecture, integration, documentation and
security review; Codex takes implementation, tests, adapters, schemas, migrations and CI. Either
agent may take any task when the other is not working; check `git status`, file modification times
and `M3GAN_STATUS.md` first so two agents never edit the same file at once (§162).

Status words: TODO, IN PROGRESS, DONE, BLOCKED.

## Now

| #   | Task                                                                                                      | Owner          | Status      |
| --- | --------------------------------------------------------------------------------------------------------- | -------------- | ----------- |
| 22  | Translate the M3GAN tab: `pnpm ui:i18n:sync`. The catalog baseline already drifted before the tab existed | chatgpt-lumina | IN PROGRESS |
| 23  | Create the append-only `m3gan_audit_checkpoints` table in Supabase (`sql/m3gan_audit_checkpoints.sql`)    | dal            | BLOCKED     |

Task 23 waits for Dal: it changes the shared Supabase project, so it is his to approve. Until then
the audit-checkpoint probe reports the external store as unavailable.

## Next

| #   | Task                                                                                                        | Owner | Status |
| --- | ----------------------------------------------------------------------------------------------------------- | ----- | ------ |
| 25  | Reinforcement learning in simulation only: domain-randomized MuJoCo episodes, evaluated before any real use | codex | TODO   |
| 27  | Acoustic pronunciation scoring for language practice                                                        | codex | TODO   |

## Done

| Task                                                                                                                                                        | Owner                      | Commit           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ---------------- |
| Cognitive core: router, attention, loop, workspace, self model, world model, body behind supervisor                                                         | claude                     | `280ea3593e4`    |
| Controller hardening, honest run-less actions, payload validation                                                                                           | codex                      | in `c4ead4d465e` |
| Safety kernel, SQLite persistence, privacy, brainstem, social layer, behaviors, HAL, dashboard                                                              | claude                     | `c4ead4d465e`    |
| One owner per tool name; live-only side effects; documentation                                                                                              | claude                     | `2017ac95e39`    |
| Tasks 2-5 and 7: durable goals, lessons and episodes; full forget-session; teleoperation; contracts split; delegation result                                | codex (finished by claude) | `7da8f6904dc`    |
| Durable stores open after activation (they were session-only live); network probe on PowerShell 5.1                                                         | claude                     | `7da8f6904dc`    |
| The M3GAN tab renders natively in the Control UI over `m3gan.*` gateway methods (ADR 0008)                                                                  | claude                     | `51cc0c47a2a`    |
| Task 6: `lumina_plan_run` walks a plan step by step under the safety gate, with ordered rollback; plan ids no longer collide                                | claude                     | `8adbc15e15f`    |
| Awareness on Windows PowerShell 5.1: every JSON query failed on a leading pipe (battery, network, disks, devices, GPU, monitors were empty)                 | claude                     | `8adbc15e15f`    |
| Task 1: activated in the live gateway and verified (tools in the catalog, durable state across restarts, `/health` ok)                                      | claude                     | 2026-10-05       |
| Task 21: recorder metadata moved to SQLite plugin state; new event artifacts use NDJSON; legacy recordings remain read-compatible                           | chatgpt-lumina             | `66c74d34954`    |
| Task 8: webcam sidecar emitting `person.detected` and sightings, gated by the camera privacy state                                                          | claude                     | `38a4c602888`    |
| Task 9: face recognition only with consent; templates deleted on revoke or forget                                                                           | claude                     | `38a4c602888`    |
| Task 10: speaker identification on `speech.detected` (Silero VAD + WeSpeaker), consented voices only                                                        | claude                     | `38a4c602888`    |
| Task 11: the mascot's expression follows the workspace (functional state, never a claimed feeling)                                                          | claude                     | `e42d1a75cc2`    |
| Task 12: consent and retention review of tasks 8 to 10: consent checked at read time, sensors follow the privacy switch at once                             | claude                     | `38a4c602888`    |
| Task 13: situational reasoner; proposals become questions at L3 and reversible initiatives at L4+                                                           | claude                     | `19293e15a24`    |
| Task 17 and 18: audit checkpoints outside the gateway; physical confirmation on the real keyboard (injected keys never count)                               | claude                     | `463d3bee4fb`    |
| Task 14: reflection over the audit and cycles proposes lessons a person accepts                                                                             | claude                     | `98ced5fdc2f`    |
| Task 16: MuJoCo body (speed limits, collisions, reach) behind the same supervisor                                                                           | claude                     | `1779e1c0fd2`    |
| Task 15: ROS 2 body adapter over rosbridge, simulation only                                                                                                 | claude                     | `5f4774a60d6`    |
| Task 19 and 20: evaluation suite for world, people, memory and body in sandboxes, plus router and loop performance                                          | claude                     | `330026142e5`    |
| Interaction modes (child, companion, maintenance) as a restriction layer (ADR 0009); curiosity; affordances; practice book; artifact registry               | claude and codex           | `b490cfda215`    |
| Task 26: child-mode guard: the mode's guidance in every turn; unsuitable replies rewritten once, replaced on the way out                                    | claude                     | `180a7c040bf`    |
| Task 24: object detector (YOLOX, COCO) in the camera sidecar feeding the world model and affordances; the plugin's Python sidecars now ship with the bundle | claude                     | `e79a086c918`    |
