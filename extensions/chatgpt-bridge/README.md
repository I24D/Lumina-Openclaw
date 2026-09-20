# ChatGPT Bridge

Relays orders from a ChatGPT tab into an OpenClaw chat session, so the operator
can drive OpenClaw by talking to ChatGPT with their voice.

## How it works

1. The plugin attaches over CDP to the managed browser tab whose URL matches
   `urlPattern` (default `chatgpt.com`).
2. It installs a `MutationObserver` in that page. The observer pushes each
   settled assistant reply out through a CDP binding, so nothing is polled, and
   it records when the operator last authored a turn.
3. When a reply carries the marker (default `@OPENCLAW:`), the text after it is
   sent to the configured session with `chat.send`.

The operator tells ChatGPT, once, in its custom instructions:

> When I ask you to send an order to OpenClaw, answer with `@OPENCLAW:` followed
> by the order on the same line.

## Why it is not a separate process

The bridge runs as a Gateway service. It starts with the Gateway, stops with it,
and needs no launcher, service wrapper or scheduled task of its own.

## Safety

Everything relayed was written by a model that reads untrusted web pages, so the
bridge treats it as hostile input:

- **Operator presence.** An order is refused unless the operator addressed
  ChatGPT within `userTurnWindowMs` (default 5 min). A page that talks ChatGPT
  into emitting the marker on its own cannot reach the session.
- **Deny list.** `denyPatterns` are case-insensitive regular expressions checked
  against the order. The defaults block Bitso and trading wording, credentials,
  `.env`, and destructive shell and git commands. A malformed pattern is treated
  as a literal rather than dropped, so a typo cannot widen what is accepted.
- **Rate limits.** `minIntervalMs` between orders and `maxPerHour` in total.
- **Replay protection.** Each ChatGPT message id is relayed at most once.
- **Provenance.** Orders enter as `external_user`, the same restricted requester
  policy applied to inbound WhatsApp and Telegram messages.

The deny list is a backstop, not a permission system. The agent's own tool
policy still governs what an order can do once it lands.

## Configuration

Under `plugins.entries.chatgpt-bridge.config` in `openclaw.json`:

| Key                | Default                  | Meaning                                      |
| ------------------ | ------------------------ | -------------------------------------------- |
| `enabled`          | `true`                   | Master switch for the watcher.               |
| `cdpUrl`           | `http://127.0.0.1:18800` | CDP endpoint of the managed browser.         |
| `sessionKey`       | `agent:main:main`        | Session that receives the orders.            |
| `agentId`          | session's own agent      | Agent that handles them.                     |
| `marker`           | `@OPENCLAW:`             | Prefix ChatGPT must emit.                    |
| `urlPattern`       | `chatgpt.com`            | Substring identifying the tab.               |
| `maxOrderChars`    | `2000`                   | Longest order accepted.                      |
| `userTurnWindowMs` | `300000`                 | How recently the operator must have spoken.  |
| `minIntervalMs`    | `3000`                   | Minimum spacing between orders.              |
| `maxPerHour`       | `40`                     | Hourly cap.                                  |
| `denyPatterns`     | see manifest             | Orders matching any of these are never sent. |

The plugin ships `enabledByDefault: false`: it watches a browser tab and writes
into a chat session, so it only runs where an operator asked for it.

## Operating notes

- The bridge reconnects on its own: if the tab or the browser closes it retries
  every few seconds, and the observer is reinstalled after a page reload.
- It never types into ChatGPT. Relaying OpenClaw's answer back would need the
  page composer, which is deliberately out of scope here.
- The marker is accepted anywhere in a line, because ChatGPT answers voice turns
  in a single paragraph and HTML collapses the newline inside one block.
