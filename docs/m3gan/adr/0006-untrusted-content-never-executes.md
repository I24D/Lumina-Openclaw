# ADR 0006: Untrusted content never executes

- Status: accepted
- Date: 2026-10-04

## Context

Web pages, mail, documents, notifications, images, QR codes, OCR text and other people's messages
can carry instructions (§101). The specification treats the Internet as a tool, not an extension of
the mind (§26), and assumes the model can be compromised (§102).

## Decision

- An event can carry an explicit trust level; otherwise `trustOf()` derives it from the source.
  Sources in `UNTRUSTED_SOURCES` (`cognition/attention.ts`) are untrusted.
- The cognitive loop handles an untrusted event at most with a proposal, marked
  `UNTRUSTED_CONTENT`; it never executes an action because of it.
- Screen perception events are untrusted, because a screen can show anything.

## Consequences

- A malicious page cannot make the core act; a person or a trusted source must take the step.
- Classification depends on each producer setting its true source. New producers add their kind
  and source to the catalog first.
