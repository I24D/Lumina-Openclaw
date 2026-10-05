# ADR 0007: One owner per tool name, and side effects only in the live gateway

- Status: accepted
- Date: 2026-10-05

## Context

`lumina-cognitive-os` and `lumina-supabase` both declared `lumina_supabase_status`, `_schema`,
`_query` and `_mutate` with separate implementations. Two plugins declaring one tool collide when
both are enabled. The contract test that should have caught it listed seven Lumina extensions that
no longer exist and missed the ones that do.

The extension also started pollers, sidecars and a hotkey in every load, including discovery and
CLI loads, and installed process-wide error handlers that kept the gateway alive after an uncaught
exception.

## Decision

- `lumina-supabase` owns the Supabase table tools. `lumina-cognitive-os` keeps only its memory view
  (`lumina_memory_status`, `lumina_memory_search`, `lumina_supabase_memory_remember`,
  `lumina_warehouse_catalog`).
- The tool contract test discovers every `lumina-*` extension on disk and fails on any tool name
  declared by more than one.
- Long-lived side effects (awareness poller, perception, kill-switch hotkey, wake word, core timers,
  durable stores, the owner channel) start only when `registrationMode === "full"`.
- The plugin installs no process-wide error handlers; the gateway owns those.

## Consequences

- Enabling both plugins is safe.
- A new Lumina extension is covered by the contract test the day it lands.
- `openclaw` CLI commands no longer spawn the extension's sidecars.
