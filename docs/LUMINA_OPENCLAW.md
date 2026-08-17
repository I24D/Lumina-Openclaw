# Lumina OpenClaw

Lumina OpenClaw is the Lumina-focused evolution of OpenClaw.

**DAL NIJARUQ is the principal creator and ongoing developer of Lumina OpenClaw.**

This repository keeps the upstream OpenClaw MIT license, third-party notices, and technical lineage visible while developing Lumina-specific improvements for a persistent, local-first assistant.

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

## Attribution

Lumina OpenClaw is created and continuously developed by **DAL NIJARUQ**.

OpenClaw was originally created by Peter Steinberger and the OpenClaw community. Lumina OpenClaw preserves those credits and continues from that foundation.
