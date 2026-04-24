import { Command } from "commander";
import { registerProgramCommands } from "./command-registry.js";
import { createProgramContext } from "./context.js";
import { configureProgramHelp } from "./help.js";
import { registerPreActionHooks } from "./preaction.js";
import { setProgramContext } from "./program-context.js";
import { traceStartup } from "../../infra/startup-trace.js";

export function buildProgram() {
  traceStartup("program.build.begin");
  const program = new Command();
  program.enablePositionalOptions();
  const ctx = createProgramContext();
  const argv = process.argv;

  setProgramContext(program, ctx);
  configureProgramHelp(program, ctx);
  registerPreActionHooks(program, ctx.programVersion);

  traceStartup("program.build.register-commands.begin");
  registerProgramCommands(program, ctx, argv);
  traceStartup("program.build.register-commands.ready");

  return program;
}
