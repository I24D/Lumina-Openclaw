# Lumina Desktop Runtime Release Contract

This document locks Phase 1 of the Tauri/Rust migration: the canonical runtime bundle format and the release manifest consumed by future bootstrap/install/update code.

## Goals

- Keep `OpenClaw` as the visible UI.
- Decouple the heavy runtime payload from the initial installer.
- Make bundle/install/update behavior deterministic across `Windows`, `macOS`, and `Linux`.
- Give the future Rust bootstrapper a stable contract before shell migration begins.

## Canonical Runtime Bundle

The canonical runtime bundle is produced in:

`apps/lumina-desktop/build/runtime-bundle`

Its archive layout is:

```text
bundle.manifest.json
payload/
  config/
    lumina-defaults.json
  node/
    ...
  openclaw/
    ...
  proxy/
    ...
  ui/
    ...
```

### Rules

- `bundle.manifest.json` is always at the archive root.
- Runtime payload files always live under `payload/`.
- Bundle entries must never contain symbolic links.
- Every entry is content-addressed with `sha256`, `byteSize`, and `fileCount`.
- Launch paths must resolve inside declared bundle entries.
- The current install strategy is `merge-contents-of-payload-root`.
- The current launch strategy is `desktop-runtime-bundle`.

### Bundle Manifest Responsibilities

`bundle.manifest.json` is the single source of truth for:

- target `platform` and `arch`
- product identity
- source package versions
- payload entry digests
- install layout
- launch entry points

The manifest schema is:

`schemas/lumina-desktop-bundle.schema.json`

The generator is:

`scripts/prepare-desktop-bundle.ts`

The bundle validator is:

`scripts/validate-release-contract.ts --bundle-only`

## Release Manifest

The release manifest is produced in:

`apps/lumina-desktop/release/lumina-release-<version>-<platform>-<arch>.manifest.json`

It is target-specific. One release manifest describes one `platform/arch` pair and one `channel`.

### Rules

- Every artifact in a release manifest must match the manifest `target.platform` and `target.arch`.
- The runtime bundle artifact must point to its paired bundle manifest using:
  - `bundleManifestRelativePath`
  - `bundleManifestSha256`
- Optional `.artifact.json` sidecars may override artifact `id`, `role`, `format`, `platform`, `arch`, and digest fields during release-manifest generation.
- Artifact digests are authoritative and must match files on disk.
- The bootstrap strategy is currently `download-and-expand-runtime-bundle`.

### Artifact Roles

- `runtime-bundle`: the heavy runtime archive downloaded by the bootstrapper.
- `bundle-manifest`: the detached copy of the runtime bundle manifest shipped with the release.
- `desktop-installer`: platform installer produced by the desktop shell pipeline.
- `bootstrap-installer`: artifact produced from the Rust bootstrapper build.

The manifest schema is:

`schemas/lumina-release-manifest.schema.json`

The generator is:

`scripts/generate-release-manifest.ts`

Both the generator and validator can receive explicit paths:

- `--bundle-manifest`
- `--release-root`
- `--output`
- `--release-manifest`
- `--canonical-bundle-root`

This keeps the contract usable from CI, fixtures, and the future Rust bootstrap pipeline.

## Validation

Two validation layers exist.

### 1. Contract Unit Tests

```powershell
node --experimental-strip-types --test --test-isolation=none tests/lumina-bundle-contract.test.ts
```

### 2. Real Artifact Validation

```powershell
node --experimental-strip-types scripts/validate-release-contract.ts
```

Package scripts:

```powershell
pnpm desktop:contract:test
pnpm desktop:contract:validate
```

This validator checks:

- bundle manifest structure
- bundle payload digests against real files
- release manifest structure
- release artifact digests against real files
- runtime bundle to bundle-manifest linkage
- release target alignment with the canonical bundle

## Release Flow

1. `pnpm desktop:tauri:archive`
2. `node --experimental-strip-types scripts/prepare-desktop-bundle.ts --skip-ui-build`
3. `node --experimental-strip-types scripts/archive-runtime-bundle.ts`
4. `pnpm desktop:bootstrapper:stage` if a bootstrapper artifact is available
5. `node --experimental-strip-types scripts/generate-release-manifest.ts --channel <stable|beta|nightly>`
6. `node --experimental-strip-types scripts/validate-release-contract.ts`
7. `node --experimental-strip-types scripts/publish-release-artifacts.ts --publish-root <dir> --base-url <https://...>`

Orchestrated end-to-end:

```powershell
node --experimental-strip-types scripts/stage-desktop-release.ts --channel stable --publish-root apps/lumina-desktop/release/publish
```

The publish layout is:

```text
apps/lumina-desktop/release/publish/
  versions/<channel>/<platform>/<arch>/<version>/
  channels/<channel>/<platform>/<arch>/
```

Rules:

- `versions/.../<version>` is the immutable publish root used by artifact URLs.
- `channels/...` is the moving latest pointer for one channel/target pair.
- published release manifests keep artifact `relativePath` values local, but artifact `url` values point to the immutable versioned root.
- `channels/.../index.json` records the latest published version for that channel/target pair.

## GitHub Releases

The GitHub release workflow now publishes one target-specific release manifest per `platform/arch` pair so assets do not collide when `Windows`, `macOS`, and `Linux` builds are attached to the same release.

Users downloading Lumina from the GitHub release page should:

- choose the `desktop-installer` asset for their operating system
- ignore the `runtime-bundle` and `bootstrap-installer` assets unless they are doing update or recovery work

## Updater

The production updater is bootstrapper-backed, not shell-specific.

- `check-update` reads a release manifest, validates the target, and compares the latest bundle version against the currently running runtime version.
- `install` downloads the `runtime-bundle`, verifies `sha256` and `byteSize`, verifies detached bundle-manifest linkage, and stages the new runtime under `~/.lumina/runtime-manager/releases`.
- the Tauri desktop shell only enables updates when `runtimeReleaseManifestUrl` is configured and uses `https` or a local file path.
- the desktop shell exposes update state through the `window.__LUMINA__` contract without requiring UI rewrites.

## Compatibility Policy

- `schemaVersion` changes only for breaking manifest changes.
- New optional fields may be added without changing `schemaVersion`.
- Existing required fields must not change semantics without a schema version bump.
- Future Tauri and Rust bootstrap code must consume this contract, not reverse-engineer folder layout.
