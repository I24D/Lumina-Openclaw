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

### 2. Fork and create a branch

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
