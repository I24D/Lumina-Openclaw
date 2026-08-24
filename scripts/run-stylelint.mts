// Runs Stylelint through the linked-worktree-aware repository toolchain.
import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  ensureRepoToolNodeModulesLink,
  resolveRepoToolBinPath,
} from "./lib/local-check-runtime.mts";
import { createManagedCommandInvocation } from "./lib/managed-child-process.mts";

const stylelintPath = resolveRepoToolBinPath("stylelint");
ensureRepoToolNodeModulesLink(stylelintPath);
// node_modules/.bin/stylelint is an extensionless shell script, which Windows
// cannot execute directly: spawning it raw fails with ENOENT. The managed
// invocation routes through cmd.exe, which applies PATHEXT.
const stylelint = createManagedCommandInvocation({
  bin: stylelintPath,
  args: ["--config", path.resolve("config", "stylelint.config.mjs"), ...process.argv.slice(2)],
});
const result = spawnSync(stylelint.command, stylelint.args, {
  env: process.env,
  stdio: "inherit",
  shell: stylelint.shell,
  windowsVerbatimArguments: stylelint.windowsVerbatimArguments,
});
if (result.error) {
  throw result.error;
}
process.exitCode = result.status ?? 1;
