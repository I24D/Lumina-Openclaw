# Lumina Design and OpenDesign

Lumina Design is the visual creation workspace maintained by **DAL NIJARUQ** for Lumina OpenClaw. It connects the authenticated OpenClaw Control UI to a local [OpenDesign](https://github.com/nexu-io/open-design) runtime without turning OpenDesign into a second autonomous assistant.

## What the integration provides

- A dedicated **Diseño** tab in the Control UI.
- Persistent OpenDesign projects, artifacts, files, skills, and design systems.
- Responsive previews on desktop and mobile through the authenticated Gateway.
- One-click access to the native OpenDesign Studio on the Gateway PC.
- Automatic startup and health monitoring for the loopback-only OpenDesign daemon.
- A Lumina-owned bridge that submits design briefs to the existing OpenClaw session.

## Model and tool policy

The active OpenClaw model remains the design brain. Lumina Design never changes the configured model and never starts an OpenDesign delegated agent run.

The MCP server is intentionally limited to discovery, project, artifact, and file-writing tools. Delegated run and destructive operations such as `start_run`, `cancel_run`, `delete_file`, and `delete_project` are excluded. OpenDesign listens on `127.0.0.1`; remote access stays behind the Gateway authentication and Tailscale configuration already used by Lumina.

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
3. The Diseño tab creates or selects a persistent project.
4. A brief is sent to the configured Lumina session with an explicit no-delegation, preserve-current-model instruction.
5. Lumina uses the allowed `open-design` MCP tools to create or update artifacts.
6. Generated HTML, SVG, and Markdown files appear in the authenticated preview panel.

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
