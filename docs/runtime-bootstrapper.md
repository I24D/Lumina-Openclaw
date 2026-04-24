# Lumina Runtime Bootstrapper

This document locks Phase 2 and Phase 3 of the desktop migration: the Rust bootstrapper that installs the heavy OpenClaw runtime outside the initial desktop installer, and the Rust runtime manager that supervises the local OpenClaw services after launch.

## Goals

- Keep the first installer small.
- Download the heavy runtime bundle on demand.
- Verify every downloaded artifact with `sha256`.
- Install atomically into versioned runtime directories.
- Preserve rollback safety by activating the new runtime only after verification succeeds.
- Move local runtime supervision out of the legacy JS shell and into Rust.
- Keep shutdown and stale-session recovery deterministic across desktop restarts.

## Source

The bootstrapper lives in:

`rust/lumina-bootstrapper`

It is intentionally isolated from `claurst/src-rust` because that workspace is not yet in a production-ready state for build orchestration.

## Commands

### Install

```powershell
lumina-bootstrapper install --release-manifest <path-or-url>
```

Responsibilities:

- read the release manifest from disk or HTTP(S)
- validate host `platform/arch`
- download the runtime bundle artifact
- download the detached bundle manifest
- verify archive and manifest `sha256`
- extract the runtime archive safely
- verify extracted payload digests against `bundle.manifest.json`
- assemble the install root
- activate the release in `state.json`

### Status

```powershell
lumina-bootstrapper status --json
```

Returns the current install root, the active release, and the current runtime-manager session if one is running.

### Resolve Runtime

```powershell
lumina-bootstrapper resolve-runtime --json
```

Returns the active runtime root plus resolved launch paths for:

- `defaultsFilePath`
- `nodeExecutablePath`
- `openClawEntryPath`
- `uiIndexPath`
- `proxyEntryPath`

### Start Runtime Manager

```powershell
lumina-bootstrapper start --runtime-root <path> --node-executable-path <path> --open-claw-entry-path <path> --proxy-entry-path <path> ...
```

Responsibilities:

- validate the launch contract passed by the desktop shell
- verify the Node runtime version
- spawn the Lumina proxy and OpenClaw gateway
- wait for local ports to become ready
- persist a runtime session file
- supervise both child processes until shutdown

### Stop Runtime Manager

```powershell
lumina-bootstrapper stop --timeout-ms 15000
```

Responsibilities:

- request a graceful shutdown through a stop-signal file
- wait for the supervising process to remove its session file
- force-kill stale processes if the graceful shutdown deadline is exceeded

## Install Layout

Default root:

`~/.lumina/runtime-manager`

Layout:

```text
~/.lumina/runtime-manager/
  downloads/
  releases/
    <bundleVersion>-<platform>-<arch>/
      bundle.manifest.json
      release.manifest.json
      config/
      node/
      openclaw/
      proxy/
      ui/
  staging/
  state.json
  runtime-session.json
  runtime-stop.signal
```

## State File

`state.json` tracks the active runtime:

- `schemaVersion`
- `updatedAt`
- `activeRelease.releaseId`
- `activeRelease.channel`
- `activeRelease.bundleId`
- `activeRelease.bundleVersion`
- `activeRelease.platform`
- `activeRelease.arch`
- `activeRelease.runtimeRoot`
- `activeRelease.bundleManifestPath`
- `activeRelease.releaseManifestSource`
- `activeRelease.installedAt`

The desktop runtime resolver in:

`apps/lumina-desktop/src/runtime-paths.ts`

now prefers this active external runtime when it exists, unless `LUMINA_USE_EXTERNAL_RUNTIME=0`.

## Runtime Session File

`runtime-session.json` tracks the active Rust sidecar session:

- `sessionId`
- `managerPid`
- `status`
- `startedAt`
- `readyAt`
- `lastHeartbeatAt`
- `runtimeRoot`
- `nodeExecutablePath`
- `nodeVersion`
- `gatewayPort`
- `proxyPort`
- `gatewayPid`
- `proxyPid`

The Tauri shell now uses this manager instead of spawning and supervising the Node services directly.

## Build and Staging

Build:

```powershell
pnpm desktop:bootstrapper:build
```

Test:

```powershell
pnpm desktop:bootstrapper:test
```

Windows toolchain script validation:

```powershell
pnpm desktop:bootstrapper:script:test
```

Stage release artifact:

```powershell
pnpm desktop:bootstrapper:stage
```

The staging script writes a `bootstrap-installer` artifact into:

`apps/lumina-desktop/release`

and the release manifest generator picks it up through `.artifact.json` metadata.

Package the desktop runtime tools:

```powershell
pnpm --dir apps/lumina-desktop prepare:runtime-tools
```

That script builds the Rust binary in `release` mode and copies it into:

`apps/lumina-desktop/build/runtime-tools`

The desktop packaging config then ships that binary under bundled app resources at `runtime-tools`.

## Windows Toolchain Resolution

On Windows, `scripts/run-cargo-bootstrapper.ts` now resolves the MSVC environment automatically before it invokes `cargo`.

Resolution order:

- `VCVARS64_BAT` if set explicitly
- `VSINSTALLDIR` if it points at a Visual Studio or Build Tools installation
- `vswhere.exe` for the latest installation that includes `Microsoft.VisualStudio.Component.VC.Tools.x86.x64`
- common fallback roots such as `C:\BuildTools`

The script then:

- calls `vcvars64.bat`
- prepends the Rust toolchain directory so `rustc.exe` is visible to Cargo build scripts
- exports `RUSTC` explicitly for deterministic builds

Required local components:

- Visual Studio 2022 Build Tools with the MSVC C++ workload
- Windows 10/11 SDK libraries

Once those components exist, `pnpm desktop:bootstrapper:test` and `pnpm desktop:bootstrapper:build` should work from a normal PowerShell session without manually opening a Developer Command Prompt first.
