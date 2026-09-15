# Contributing to Lumina OpenClaw

Thank you for helping improve Lumina OpenClaw. Contributions from the community
are welcome: code, documentation, translations, tests, bug reports, design
feedback, skills, plugins, and integration ideas all help the project grow.

Lumina OpenClaw is created and continuously developed by **DAL NIJARUQ**. It is
built on OpenClaw and preserves its MIT license, credits, and technical lineage.

## Quick links

- [Open an issue](https://github.com/I24D/Lumina-Openclaw/issues/new/choose)
- [Find an issue to work on](https://github.com/I24D/Lumina-Openclaw/issues?q=is%3Aissue+is%3Aopen+label%3A%22help+wanted%22)
- [Start a discussion](https://github.com/I24D/Lumina-Openclaw/discussions)
- [Open a pull request](https://github.com/I24D/Lumina-Openclaw/compare)
- [Read the code of conduct](CODE_OF_CONDUCT.md)
- [Report a security issue](SECURITY.md)

## Guia rapida en espanol

No necesitas acceso directo de escritura para colaborar. Haz un **fork** del
repositorio, crea una rama en tu fork y envia un **Pull Request** hacia la rama
`main` de `I24D/Lumina-Openclaw`.

1. Abre un Issue o una Discussion para cambios grandes.
2. Haz fork del repositorio y clona tu fork.
3. Crea una rama con un nombre claro, por ejemplo `fix/start-talk-layout`.
4. Realiza un cambio enfocado y agrega las pruebas necesarias.
5. Sube tu rama y abre un Pull Request usando la plantilla del repositorio.
6. Manten activada la opcion **Allow edits from maintainers**.

Los arreglos pequenos y claros pueden enviarse directamente como Pull Request.
Nunca publiques claves, tokens, datos personales, conversaciones privadas ni
archivos `.env`.

## Contribution workflow

### 1. Choose or propose work

For a small bug fix, documentation correction, or translation, you may open a
pull request directly. For a new feature, architecture change, or broad UI
change, open an issue or discussion first so the direction can be agreed before
you invest significant time.

Good starting points are issues labeled
[`good first issue`](https://github.com/I24D/Lumina-Openclaw/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22)
or
[`help wanted`](https://github.com/I24D/Lumina-Openclaw/issues?q=is%3Aissue+is%3Aopen+label%3A%22help+wanted%22).

## PR Limits

We cap at **20 open PRs per author**. If you exceed this, the `r: too-many-prs` label is added and your PR is auto-closed. This is a hard limit.

For coordinated change sets that genuinely need more than 20 PRs, join the **#clawtributors** channel in Discord and talk to maintainers first.

## Source dependencies

Run `pnpm install --frozen-lockfile` from the workspace root. Source checkouts use
pnpm's isolated linker, which keeps dependencies in `node_modules/.pnpm` and links
them into each workspace package. On supported macOS volumes, this also lets pnpm
reuse whole-package APFS clones instead of importing every file separately.

Give each source checkout its own physical dependency installation. Tooling does
not automatically link a missing `node_modules` to another checkout. Existing
borrowed installs can still serve direct Node tooling. Normal pnpm install checks
the checkout-root `node_modules`, the explicitly configured root module directory,
and their `.pnpm` directories before reconciliation, refusing borrowed links there.
Preserve that donor and create an independently owned install instead of removing
or reinstalling through its link. Explicit hydrated module directories remain
supported when the workspace link points to the configured physical directory.
This admission check runs through `pnpm:devPreinstall`; `--ignore-scripts` skips
it. The check does not lock paths against concurrent replacement, inspect every
workspace package's dependencies, or validate every alternate pnpm directory setting.

When updating a checkout that used the hoisted layout, stop builds, tests, and
watchers using that checkout's dependencies before running the install command.
Do not change the linker while other jobs are using the same `node_modules`.
Declare dependencies in the package that imports them; root tooling and tests
must declare their own development dependencies rather than rely on hoisting.

## Before You PR

- Use **Node 24.16+ LTS** or **Node 26.1+** for source checkouts. Older Node releases can truncate SQLite TEXT reads; Node 22, 23, and 25 are unsupported. See [Node install guidance](docs/install/node.md) if your local version is too old.
- Run the Vitest 5 suite on Node 24.16+ or Node 26.1+, matching the packaged runtime floor.
- Test locally with your OpenClaw instance
- An explicit maintainer repair-and-land request covers internal database scheduling, admission, and lifecycle decisions. The implementer owns the design and its verification. Get separate design acceptance when changing public contracts, schemas, durability, retention, or permissions; see the [database schema review checkpoint](docs/reference/database-schemas.md#review-checkpoint-for-material-changes).
- External PRs must describe the user, product, or operational problem in **What Problem This Solves** and include useful validation in **Evidence**. Focused tests, CI results, screenshots, recordings, terminal output, live observations, redacted logs, and artifact links all count. Reviewers will inspect the code, tests, and CI; use the PR body to explain intent and make validation easy to understand.
- Follow the [PR template](.github/pull_request_template.md): lead with the plain-language problem and concrete user impact, then a brief explanation and useful evidence. Keep technical inventories in the diff or optional details, not the opening summary. Keep important risks, migrations, required actions, and evidence gaps visible; do not invent a user benefit for internal-only work.
- When ClawSweeper, Barnacle, or a maintainer asks for more context or evidence, edit the PR description instead of only replying in a new comment. Keep **What Problem This Solves**, **User Impact**, **Why This Change Was Made**, and **Evidence** current; a short comment can point reviewers to the update, but the PR body should remain the durable explanation for maintainers and bots.
- Keep PRs takeover-ready: open them from a branch maintainers can push to. For fork PRs, leave GitHub's **Allow edits by maintainers** option enabled so maintainers can finish urgent fixes or merge prep when needed. If GitHub shows **Allow edits and access to secrets by maintainers**, enable it only when that workflow/secrets access is acceptable and say so in the PR.
- Do not edit the generated `CHANGELOG.md` index or release-owned `CHANGELOG/**` entries and contribution records in normal PRs or at merge. Initial changelogs are generated at release time from merged PRs and commits; keep release-note context in PR bodies or commit messages until then. Explicit release-docs publication changes follow the [release artifact procedure](docs/reference/RELEASING.md#release-changelog-artifacts).
- Run tests: `pnpm build && pnpm check && pnpm test`
- For iterative local commits after running equivalent targeted validation for the touched surface, `git commit --no-verify` skips commit hooks.
- For extension/plugin changes, run the fast local lane first:
  - `pnpm test:extension <extension-name>`
  - `pnpm test:extension --list` to see valid extension ids
  - If you changed shared plugin or channel surfaces, run `pnpm test:contracts`
  - For targeted shared-surface work, use `pnpm test:contracts:channels` or `pnpm test:contracts:plugins`
  - These commands also cover the shared seam/smoke files that the default unit lane skips
  - If you changed broader runtime behavior, still run the relevant wider lanes (`pnpm test:extensions`, `pnpm test:channels`, or `pnpm test`) before asking for review
- If you touched bundled-plugin boundaries in shared code, run the matching inventories:
  - `node --import tsx scripts/check-src-extension-import-boundary.mts --json` for `src/**`
  - `node --import tsx scripts/check-sdk-package-extension-import-boundary.mts --json` for `src/plugin-sdk/**` and `packages/**`
  - `node --import tsx scripts/check-test-helper-extension-import-boundary.mts --json` for `test/helpers/**`
- Shared test helpers must use `src/test-utils/bundled-plugin-public-surface.ts` instead of repo-relative `extensions/**` imports. Keep plugin-local deep mocks inside the owning bundled plugin package.
- If you are using an AI coding agent with OpenClaw skills available, run the `autoreview` skill before opening or updating your PR. Address accepted/actionable findings before asking for review.
- Do not submit refactor-only PRs unless a maintainer explicitly requested that refactor for an active fix or deliverable.
- Do not submit test or CI-config fixes for failures already red on `main` CI. If a failure is already visible in the [main branch CI runs](https://github.com/openclaw/openclaw/actions), it's a known issue the Maintainer team is tracking, and a PR that only addresses those failures will be closed automatically. If you spot a _new_ regression not yet shown in main CI, report it as an issue first.
- Do not submit test-only PRs that just try to make known `main` CI failures pass. Test changes are acceptable when they are required to validate a new fix or cover new behavior in the same PR.
- Ensure CI checks pass
- Keep PRs focused (one thing per PR; do not mix unrelated concerns)
- Describe what & why
- **Include screenshots** — one showing the problem/before, one showing the fix/after (for UI or visual changes)
- Use American English spelling and grammar in code, comments, docs, and UI strings
- Do not edit files covered by `CODEOWNERS` security ownership unless a listed owner authored or explicitly requested the change, or is already reviewing it with you. For governance changes to ownership/review policy itself, explicit direction from an organization owner is also sufficient only when live GitHub organization membership shows `state: active` and `role: admin`; repository `ADMIN`, `viewerCanAdminister`, or bypass permission alone never qualifies. Neither route waives a GitHub-enforced approval rule. Treat those paths as restricted review surfaces, not opportunistic cleanup targets.

## Local commit hook

The normal `pnpm install` setup enables the repository's pre-commit formatting hook
when `core.hooksPath` is unset. Existing hook selections, including an explicitly
empty value, are preserved. Git scopes initialization to the current checkout.
With multiple worktrees, automatic setup requires `extensions.worktreeConfig`;
otherwise Git reports a warning and installation continues without changing hook
settings. The repository owner can enable per-worktree configuration following
[Git's configuration guidance](https://git-scm.com/docs/git-worktree#_configuration_file).

The hook's optional content guard reads a private UTF-8 file selected by
the native Git setting `hooks.blockedLiteralsFile`. Keep one literal per nonempty
line in a file outside the checkout, such as
`~/.config/openclaw/blocked-literals.txt`, then configure this checkout:

```bash
git clone https://github.com/YOUR-USER/Lumina-Openclaw.git
cd Lumina-Openclaw
git remote add upstream https://github.com/I24D/Lumina-Openclaw.git
git switch -c fix/short-description
```

Use a short branch prefix such as `fix/`, `feat/`, `docs/`, `test/`, or
`community/`. Keep each pull request focused on one problem.

### 3. Set up the project

Lumina OpenClaw is a pnpm workspace. Plain `npm install` at the repository root
is not supported.

```bash
pnpm install
pnpm build
pnpm ui:build
```

Use Node.js 24.15 or newer when possible. The project also supports Node.js
22.22.3 or newer and Node.js 25.9 or newer.

### 4. Validate the change

Built with Codex, Claude, or other AI tools? **Welcome!** No AI-assistance
label or disclosure is required.

Run the narrowest relevant tests while developing, then broaden validation in
proportion to the change:

```bash
pnpm check
pnpm test
pnpm build
```

For UI changes, include before-and-after screenshots and verify the relevant
desktop and mobile layouts. For extension changes, run
`pnpm test:extension <extension-name>` first. Never alter tests only to hide a
real failure. Confirm you understand what the code does.

AI PRs are first-class citizens here and follow the same quality and review
standards as any other PR.

### 5. Open the pull request

Push your branch to your fork and open a pull request against
`I24D/Lumina-Openclaw:main`. Complete the repository template and include:

- the problem and why it matters;
- the solution and its user impact;
- a linked issue when one exists (`Closes #123` or `Related: #123`);
- tests, screenshots, logs, or other evidence;
- any compatibility, migration, privacy, or security considerations.

Keep **Allow edits from maintainers** enabled so DAL NIJARUQ can help finish the
branch when necessary. Reviews may request changes before a contribution is
merged. A submitted pull request does not guarantee acceptance.

## What belongs here

Lumina-specific work belongs in this repository, including its assistant
experience, memory, Supabase integration, observability, WhatsApp operations,
model discipline, documentation, branding, and developer tooling.

If a change is useful only to upstream OpenClaw and does not relate to Lumina,
consider proposing it at
[openclaw/openclaw](https://github.com/openclaw/openclaw) instead. When a Lumina
change modifies inherited OpenClaw behavior, explain that boundary in the pull
request.

## AI-assisted contributions

AI-assisted contributions are welcome. Disclose meaningful AI assistance in the
pull request, confirm that you understand the submitted code, and review all
generated content for correctness, licenses, privacy, and secrets. The author is
responsible for the final contribution regardless of which tools helped create
it.

## Community and safety

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
Do not use public issues or discussions for vulnerabilities or exposed secrets;
follow [SECURITY.md](SECURITY.md) instead.

All accepted contributions are provided under the repository's MIT license.
