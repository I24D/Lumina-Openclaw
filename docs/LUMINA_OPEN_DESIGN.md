# Lumina Design and OpenDesign

## Designing from the Lumina chat

Lumina can create OpenDesign artifacts directly from an ordinary chat request, for example:

- `Diseña una landing page para Lumina Code.`
- `Crea un dashboard para revisar memoria y conversaciones.`
- `Haz un poster para un negocio de tacos.`

The bundled `lumina-design` skill routes these requests to the `open-design__*` MCP tools. The result is stored in the same OpenDesign Studio data directory used by the Diseño workspace, so the user can continue editing it visually.

OpenDesign Studio selects a new loopback daemon port on each launch. Do not configure the MCP client with the legacy fixed port `7456`. Use `extensions/lumina-open-design/scripts/open-design-mcp-bridge.cjs`; it discovers the current daemon through the Studio IPC pipe, launches Studio when needed, and then starts the packaged MCP process with Electron's bundled Node runtime.

Lumina Design is the visual creation workspace maintained by **DAL NIJARUQ** for Lumina OpenClaw. It connects the authenticated OpenClaw Control UI to a local [OpenDesign](https://github.com/nexu-io/open-design) runtime without turning OpenDesign into a second autonomous assistant.

## What the integration provides

- A dedicated **Diseño** entry that opens a clean, independent browser window.
- Persistent OpenDesign projects, artifacts, files, skills, and design systems.
- Responsive previews on desktop and mobile through the authenticated Gateway.
- One-click access to the native OpenDesign Studio on the Gateway PC.
- Automatic startup and health monitoring for the loopback-only OpenDesign daemon.
- A Lumina-owned bridge that submits design briefs to the existing OpenClaw session.

## Model and tool policy

The active OpenClaw model remains the design brain. Lumina Design never changes the configured model and never starts an OpenDesign delegated agent run.

The MCP server is intentionally limited to discovery, project, artifact, and file-writing tools. Delegated run and destructive operations such as `start_run`, `cancel_run`, `delete_file`, and `delete_project` are excluded. OpenDesign listens on `127.0.0.1`; remote access stays behind the Gateway authentication and Tailscale configuration already used by Lumina.

The embedded workspace uses the plugin-frame cookie only for authenticated, read-only previews. Project creation and Studio launch requests cross a narrow `postMessage` allowlist and are executed by the parent Control UI through its authenticated Gateway WebSocket. The bridge accepts only the exact Lumina Design frame, origin, and methods; it does not weaken Gateway HTTP authentication or grant generic plugin calls.

## Windows setup

1. Install the current Windows release from the [OpenDesign releases](https://github.com/nexu-io/open-design/releases).
2. Start or restart the Lumina OpenClaw Gateway.
3. Open the Control UI and select **Diseño**.

The default installation paths are detected automatically:

```text
%LOCALAPPDATA%\Programs\Open Design\Open Design.exe
%LOCALAPPDATA%\Programs\Open Design\resources\app\prebundled\daemon\daemon-cli.mjs
```

Custom paths and the design session can be configured under `plugins.entries.lumina-open-design.config` in `~/.openclaw/openclaw.json`.

## Runtime flow

1. The plugin checks `http://127.0.0.1:7456/api/health`.
2. If needed, it launches OpenDesign's packaged daemon with Electron's Node runtime.
3. The Diseño entry opens a detached Control UI window and selects a persistent project or asks the authenticated bridge to create one.
4. The bridge sends the brief to the configured Lumina session with an explicit no-delegation, preserve-current-model instruction.
5. Lumina uses the allowed `open-design` MCP tools to create or update artifacts.
6. Generated HTML, SVG, and Markdown files appear in the authenticated read-only preview panel.

## Validation

```powershell
node dist/index.js plugins list --json
node dist/index.js mcp doctor open-design --probe --json
node dist/index.js mcp probe open-design --json
node dist/index.js gateway status
```

The MCP probe should report no diagnostics and must not expose delegated-run or destructive tools. The selected model can be verified independently with the normal OpenClaw session status command.

## Troubleshooting

- **OpenDesign no instalado:** install the Windows application or configure its executable and CLI paths.
- **OpenDesign sin conexión:** restart the Gateway; its plugin service will retry the local daemon.
- **No aparecen artefactos:** open the project in the Diseño tab and confirm the Lumina session completed its design request.
- **La vista remota no abre:** verify the Gateway and Tailscale endpoint first; the OpenDesign daemon itself must remain loopback-only.

OpenDesign is an external Apache-2.0 project and is not vendored into this repository. Lumina OpenClaw's own license and upstream OpenClaw attribution remain unchanged.
