// Publishes the working tree of the local grafted branch to origin/main.
//
// The local branch carries OpenClaw's real 80,057-commit ancestry so that
// `git pull upstream main` works. That ancestry cannot be pushed to
// I24D/Lumina-Openclaw: GitHub rejects every pack containing it with
// "did not receive expected object e27e2d08...", reproducibly, including
// delta-free packs built from a locally verified-complete object closure.
// A normal-sized pack carrying just the tree is accepted, so publishing means
// committing the current tree on top of whatever origin/main already is.
//
// Run with: pnpm lumina:publish
import { execFileSync } from "node:child_process";

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function main(): void {
  const dirty = git("status", "--porcelain", "--untracked-files=no");
  if (dirty) {
    console.error("Refusing to publish a dirty tree. Commit or stash first:\n" + dirty);
    process.exitCode = 1;
    return;
  }

  git("fetch", "origin", "main");
  const localTree = git("rev-parse", "HEAD^{tree}");
  const remoteHead = git("rev-parse", "origin/main");
  const remoteTree = git("rev-parse", "origin/main^{tree}");

  if (localTree === remoteTree) {
    console.log("origin/main already carries this exact tree. Nothing to publish.");
    return;
  }

  const subject = git("log", "-1", "--format=%s");
  const localHead = git("rev-parse", "--short", "HEAD");
  const message = [
    subject,
    "",
    `Published from the grafted local branch at ${localHead}.`,
    "The upstream ancestry stays local; see docs/LUMINA_OPENCLAW.md.",
  ].join("\n");

  const snapshot = git("commit-tree", localTree, "-p", remoteHead, "-m", message);
  git("push", "--no-thin", "origin", `${snapshot}:refs/heads/main`);
  console.log(`Published ${localTree.slice(0, 12)} as ${snapshot.slice(0, 12)} on origin/main.`);
}

main();
