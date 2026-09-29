# Lumina OpenClaw

Lumina OpenClaw is the Lumina-focused evolution of OpenClaw.

**DAL NIJARUQ is the principal creator and ongoing developer of Lumina OpenClaw.**

This repository keeps the upstream OpenClaw MIT license, third-party notices, and technical lineage visible while developing Lumina-specific improvements for a persistent, local-first assistant.

## Lumina Project Family

Lumina is one connected project expressed through three public repositories:

1. **[Lumina OpenClaw](https://github.com/I24D/Lumina-Openclaw)** - the assistant gateway, memory, WhatsApp operations, diagnostics, and local runtime.
2. **[Lumina Code](https://github.com/I24D/Lumina_Code)** - the coding/developer surface for Lumina workflows.
3. **[Lumina Novela](https://github.com/I24D/Lumina-Novela)** - the narrative origin and story world behind Lumina.

They are different parts of the same Lumina project by **DAL NIJARUQ**.

## Current Direction

- Keep Ollama Cloud GLM 5.2 as the selected model unless the operator explicitly changes it.
- Use Supabase as the operational base for memory, evidence, SQL, user data, and conversation archives.
- Close the memory loop: conversation capture, fact extraction, memory-wiki/Supabase storage, and agent recall.
- Treat WhatsApp, the local gateway, and session continuity as first-class Lumina workflows.
- Improve diagnostics through health checks, session logs, Prometheus/OpenTelemetry, QA lab, and workboard visibility.

## Public Repository Notes

- Do not commit real `.env` files, API keys, Supabase service keys, WhatsApp secrets, or local auth material.
- Local development should use `pnpm install`, `pnpm lumina:health`, and focused tests before publishing runtime changes.
- OpenClaw upstream documentation remains useful for core concepts, channels, gateway behavior, and security posture.

## Staying Current With Upstream OpenClaw

Current integration: OpenClaw `2026.9.6` at official commit
`039b32a68a0` (merged 2026-09-28).

This repository tracks `openclaw/openclaw` as a real git ancestor, so upstream
releases arrive through an ordinary pull:

```bash
git remote add upstream https://github.com/openclaw/openclaw.git   # once
git fetch upstream main
git merge upstream/main
pnpm install
```

Conflicts can only appear in the files Lumina actually modifies. Everything
else fast-forwards untouched. The Lumina-owned surface is:

| Area                                 | Files                                                                                                                                                                                                                                                             |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lumina plugins (no upstream path)    | `extensions/lumina-{cognitive-os,context-engine,open-design,supabase}/**`, `extensions/chatgpt-bridge/**`, `extensions/cline/**`                                                                                                                                  |
| Lumina Design tab hooks              | `packages/gateway-protocol/src/schema/plugins.ts`, `src/plugins/registry-control-ui.ts`, `src/gateway/control-ui-plugin-tabs.ts`, `ui/src/app/app-shell-{view,plugin-window}.ts`, `ui/src/components/app-sidebar-nav-menus.ts`, `ui/src/styles/plugin-window.css` |
| Talk playback backpressure           | `ui/src/pages/chat/talk/{audio,google-live}.ts`                                                                                                                                                                                                                   |
| WhatsApp outbound safety             | `extensions/whatsapp/src/outbound-safety.ts`, `send.ts`, `auto-reply/monitor/{inbound-dispatch,on-message}.ts`                                                                                                                                                    |
| WhatsApp outage resilience           | `extensions/whatsapp/src/lumina-resilience{,.runtime}.ts`, `reconnect.ts`, `connection-controller.ts`, `channel.ts`                                                                                                                                               |
| Contact-channel guard and read aloud | `src/lumina/**`, `src/auto-reply/reply/{agent-runner-result-payloads,dispatch-from-config.finalize}.ts`, `src/gateway/server-core-runtime.ts`, `src/plugins/host-hooks.ts`                                                                                        |
| Windows fixes                        | `src/infra/tailscale.ts`, `src/shared/tailscale-status.ts` (tailscale.exe outside PATH), `src/config/sessions/session-transcript-worker-resources.ts` (Proxy env sent to the worker)                                                                              |
| Browser pointer motion               | `extensions/browser/src/browser/pointer-{motion,trajectory}.ts`, `pw-tools-core.interactions.actions.ts`                                                                                                                                                          |
| Native session catalogs              | `extensions/anthropic/session-catalog-*.ts`, `extensions/acpx/src/codex-auth-bridge.ts`, `scripts/lib/native-session-catalogs.json`, `ui/src/pages/config/session-sources.ts`                                                                                     |
| Memory evaluation                    | `extensions/memory-core/src/concept-vocabulary.ts`, `scripts/lumina-memory-eval.ts`, `scripts/lumina-procedural-memory.ts`                                                                                                                                        |
| Branding, docs and skills            | `README.md`, `VISION.md`, `AGENTS.md`, `CONTRIBUTING.md`, `docs/LUMINA_*.md`, `docs/assets/lumina-openclaw-banner-*.svg`, `skills/bitso/**`, `package.json`                                                                                                       |
| CI and scripts                       | `.github/workflows/lumina-baseline-ci.yml`, fork guards on `auto-response.yml` and `clawsweeper-dispatch.yml`, `scripts/lumina-dev-healthcheck.mts`, `scripts/lumina-publish-github.ts`                                                                           |

Two upstream behaviours to expect when merging:

- `pnpm-lock.yaml` is generated. Resolve it by taking upstream's file and
  running `pnpm install`; the `extensions/lumina-supabase` workspace entry is
  regenerated automatically from the `extensions/*` glob.
- When upstream rewrites a subsystem Lumina has patched, a textual merge will
  produce code that compiles against APIs that no longer exist. Check that the
  surrounding functions still exist before accepting a clean-looking merge.
  This is what retired the 7.2 sidebar thread unification at the 8.1 graft.

## Publishing to GitHub

The local branch and `origin/main` deliberately carry different histories.

Locally, `main` descends from `openclaw/openclaw` so upstream releases arrive
through an ordinary merge. That ancestry cannot be pushed to this repository:
GitHub rejects every pack containing it with `did not receive expected object
e27e2d08…`, reproducibly, and it is not a local defect — `git fsck` is clean,
and the failure survives delta-free packs built from an object closure verified
complete. A normal-sized pack carrying only the tree is accepted.

So publishing means committing the current tree on top of whatever `origin/main`
already is:

```bash
pnpm lumina:publish
```

The script refuses to run on a dirty tree, skips when the published tree already
matches, and otherwise pushes one commit whose tree is identical to local HEAD.
Verify with:

```bash
git rev-parse origin/main^{tree} HEAD^{tree}   # the two hashes must match
```

The practical trade-off: clones of this repository get the code, not OpenClaw's
80,057-commit history. For a public fork that is arguably the better default —
a clone stays small. Full history lives in the working copy, which is where
merging upstream actually happens.

## Attribution

Lumina OpenClaw is created and continuously developed by **DAL NIJARUQ**.

OpenClaw was originally created by Peter Steinberger and the OpenClaw community. Lumina OpenClaw preserves those credits and continues from that foundation.
