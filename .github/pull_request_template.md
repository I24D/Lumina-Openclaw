<!--
Optional linked context:
Add a visible `Closes #<issue-number>` or `Related: #<issue-number>` line
below this comment.

Write for someone who uses OpenClaw but has not read the code. The title and
opening problem statement should make sense without the diff or linked issue.

Required PR title:
type: <what changes for the person affected>
Types: feat, fix, improve, refactor, docs, chore.
Use a parenthesized scope only when it helps that reader.

Name the affected task and the symptom or outcome, not the implementation:
Good: fix: keep automations running when you open another chat
Bad: fix(cron): guard missing session IDs during authority restoration
Good: fix: let users sign in again after their session expires
Bad: fix(auth): add a null check to the token refresh handler

For internal-only work, name the actual developer or operator workflow affected.

**MUST:** Keep **Allow edits from maintainers** enabled for this PR so maintainers
can help update the branch when needed.
-->

## Related issue

<!-- Use `Closes #<issue-number>`, `Fixes #<issue-number>`, or `Related: #<issue-number>`. -->

## What Problem This Solves

<!--
Describe the concrete user, product, or operational problem.
In 1–3 short, plain-language sentences, explain what someone is trying to do,
what goes wrong or is missing, and why it matters. For a fix, include the trigger
when known. For other changes, describe the need without inventing a bug.

Good: "Opening another chat can turn off a reply watcher, so it stops checking
until you notice and re-enable it."
Bad: "Fixes incorrect operator-authority invalidation on session identity mutation."

Describe the experienced problem, not just the code change. Save function names,
missing checks, and the root-cause walkthrough for the explanation below.
-->

## User Impact

<!-- Explain the complete solution and any important non-goals. -->

## Why This Change Was Made

<!-- What can users or operators now do or expect? -->

## Evidence

<!--
Show the most useful proof that this change works. Screenshots, screencasts,
terminal output, focused tests, CI results, live observations, redacted logs,
and artifact links are all useful. For visual web/macOS/iOS/Android changes, follow
the PR visual-proof standard and its screenshot delivery gate:
https://github.com/openclaw/openclaw/blob/main/.agents/skills/openclaw-pr-maintainer/references/media.md#pr-visual-proof
Keep the clean before/after pair visible first, then the annotated pair.

Start with the behavior checked and the result in plain language. Reviewers will
inspect the code, tests, and CI; do not make them decode command lists to learn
what was verified. Put exact commands, commit hashes, and long output in links
or optional <details>. Keep the useful evidence summary and meaningful gaps visible.
-->

## Contribution checklist

- [ ] I kept this pull request focused on one problem.
- [ ] I tested the affected behavior and listed the evidence above.
- [ ] I added or updated tests and documentation where appropriate.
- [ ] I did not include secrets, private data, generated build output, or `.env` files.
- [ ] I reviewed the [Code of Conduct](https://github.com/I24D/Lumina-Openclaw/blob/main/CODE_OF_CONDUCT.md) and [contribution guide](https://github.com/I24D/Lumina-Openclaw/blob/main/CONTRIBUTING.md).
- [ ] I kept **Allow edits from maintainers** enabled.
- [ ] I disclosed meaningful AI assistance below, or wrote `None`.

## AI assistance

<!-- Name the tool and briefly explain how it was used, or write `None`. -->
