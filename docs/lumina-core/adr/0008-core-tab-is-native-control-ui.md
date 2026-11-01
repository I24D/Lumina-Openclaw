# ADR 0008: The Lumina tab is a native Control UI view

- Status: accepted
- Date: 2026-10-05
- Amends: ADR 0004

## Context

ADR 0004 put the owner's channel behind a page the plugin served itself under
`/plugins/lumina-cognitive-os/core`, opened from a Control UI tab. That page carried its own
HTML, styles and polling, a second UI beside the one LUMINA already has. Embedded in the Control
UI, its frame is sandboxed without same-origin access, so it could not reach its own API there.
Dal asked for no new UI and no repeated code.

## Decision

- The Lumina tab renders natively in the Control UI, the way the Logbook tab does: a bundled view
  (`ui/src/pages/plugin/lumina-core-view.ts`) with the Control UI's cards, tables, chips, buttons, sub
  tabs and translations.
- The view talks to the core through gateway methods over the operator's authenticated session:
  `lumina.core.state` and `lumina.core.audit.verify` need `operator.read`; every command (`lumina.core.override`,
  `lumina.core.privacy`, `lumina.core.confirm`, `lumina.core.estop.rearm`, `lumina.core.people.*`, `lumina.core.world.forget`,
  `lumina.core.teleop`) needs `operator.write`.
- The commands live once, transport-agnostic, in `dashboard/owner-channel.ts`.
- Plain HTTP keeps only `/health`, `/ready` and `/version` (spec §112), for supervisors and scripts.
- The self-served page and its JSON routes are gone.

## Consequences

- One UI, one look, one place to change the owner's controls.
- English strings live in `ui/src/i18n/locales/en-lumina-core.ts`; other locales fall back to English
  until the translation pipeline runs, as for other new tabs.
- The residual risk in ADR 0004 is unchanged: an agent driving a browser that holds an operator
  session could reach these methods.
