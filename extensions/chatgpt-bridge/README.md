# ChatGPT Bridge

The preferred integration is the local MCP server in
`scripts/lumina-mcp-server.mjs`. It lets the ChatGPT desktop app delegate work
to Lumina and receive the result without an OpenAI API key, a public listener,
or browser-page scraping.

## Local MCP for ChatGPT Voice

Configure the ChatGPT desktop app with this stdio server:

```toml
[mcp_servers.lumina_openclaw]
command = "C:\\nvm4w\\nodejs\\node.exe"
args = ["C:\\I24D_WhatsApp\\openclaw-main\\extensions\\chatgpt-bridge\\scripts\\lumina-mcp-server.mjs"]
startup_timeout_sec = 20
tool_timeout_sec = 620
```

The server exposes:

- `lumina_status` — verify the local Gateway and connected channels.
- `lumina_ask` — send an order and wait for one short, recoverable interval.
- `lumina_delegate` — start durable work and immediately return a `runId`.
- `lumina_wait` — poll for at most 25 seconds without cancelling the run.
- `lumina_tasks` — list the durable inbox and recover a lost `runId`.
- `lumina_cancel` — stop the active or named run.
- `lumina_capabilities` — describe the supported work categories.

### Long-running tasks

ChatGPT and Remote Desktop Commander can stop waiting after about one minute,
so the bridge never holds one request open for the whole task. Long work uses a
durable handoff:

1. `lumina_delegate` submits the task once and returns its `runId`.
2. Lumina continues independently with an unlimited OpenClaw run window.
3. A Gateway-side observer records the terminal answer in plugin state even if
   ChatGPT disconnects or its tool request times out.
4. `lumina_wait` performs short polls. A `pending` result is not a failure and
   never cancels Lumina.
5. `lumina_tasks` recovers recent running or completed jobs after a new chat,
   application restart, or lost `runId`.

The durable inbox retains up to 10,000 jobs and survives MCP/Desktop Commander
disconnects and Gateway restarts. Only an explicit `lumina_cancel` call aborts a
run; losing the caller no longer sends an implicit cancellation.

For Remote Desktop Commander, use the short-lived CLI instead of launching the
stdio MCP server as an ordinary process:

```powershell
node C:\I24D_WhatsApp\openclaw-main\extensions\chatgpt-bridge\scripts\lumina-task-cli.mjs delegate-watch --instruction "Revisa el estado del Gateway"
```

`delegate-watch` prints the `runId` immediately, then remains as a background
process until the durable result is available. Desktop Commander can read that
process later. If it loses the process id, recover through `list` and `wait`:

```powershell
node C:\I24D_WhatsApp\openclaw-main\extensions\chatgpt-bridge\scripts\lumina-task-cli.mjs list --limit 20
node C:\I24D_WhatsApp\openclaw-main\extensions\chatgpt-bridge\scripts\lumina-task-cli.mjs wait --run-id RUN_ID --timeout-seconds 20
```

All orders use the dedicated `agent:main:chatgpt-voice` session and enter
OpenClaw with `external_user` provenance. Existing OpenClaw tool policies and
approval requirements still apply. Override the fixed target only in the host
environment with `OPENCLAW_CHATGPT_AGENT_ID` and
`OPENCLAW_CHATGPT_SESSION_KEY`.

After changing the MCP configuration, restart the ChatGPT desktop app. Start a
new chat with the MCP server enabled, then say, for example:

> Conecta con Lumina y pídele que revise el estado del Gateway.

## Legacy browser relay

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
