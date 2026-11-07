import { describe, expect, it } from "vitest";
import {
  chunkFormatFilesForCommand,
  defaultFormatCommandLineBytes,
} from "../../scripts/lib/format-command-batches.mts";

// cmd.exe truncates its /c argument at 8191 characters without reporting an
// error, so a batch that crosses it loses its tail: the files at the end are
// never formatted and the command still exits 0.
const CMD_EXE_COMMAND_LINE_LIMIT = 8191;

function renderedCmdExeLength(prefixArgs: string[], chunk: string[]) {
  // What buildCmdExeCommandLine produces: the shim path, then every argument
  // quoted and space separated.
  const shimPath = "C:\\I24D_WhatsApp\\openclaw-main\\.tools\\bin\\oxfmt.cmd";
  return [shimPath, ...prefixArgs, ...chunk].map((arg) => `"${arg}"`).join(" ").length;
}

describe("chunkFormatFilesForCommand", () => {
  const prefixArgs = ["--write", "--threads=1", "--config", "C:\\repo\\.oxfmtrc.jsonc"];
  const files = Array.from(
    { length: 600 },
    (_, index) => `docs/section-${index}/a-reasonably-long-page-name.md`,
  );

  it("keeps the Windows default under the cmd.exe command line limit", () => {
    const chunks = chunkFormatFilesForCommand(
      files,
      prefixArgs,
      defaultFormatCommandLineBytes("win32"),
    );

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(renderedCmdExeLength(prefixArgs, chunk)).toBeLessThan(CMD_EXE_COMMAND_LINE_LIMIT);
    }
  });

  it("batches every file exactly once", () => {
    const chunks = chunkFormatFilesForCommand(
      files,
      prefixArgs,
      defaultFormatCommandLineBytes("win32"),
    );

    expect(chunks.flat()).toEqual(files);
  });

  it("leaves other platforms on the larger budget", () => {
    expect(defaultFormatCommandLineBytes("linux")).toBeGreaterThan(
      defaultFormatCommandLineBytes("win32"),
    );
    expect(
      chunkFormatFilesForCommand(files, prefixArgs, defaultFormatCommandLineBytes("linux")).length,
    ).toBeLessThan(
      chunkFormatFilesForCommand(files, prefixArgs, defaultFormatCommandLineBytes("win32")).length,
    );
  });

  it("never drops a file that alone exceeds the budget", () => {
    const single = ["docs/".padEnd(9000, "x") + ".md"];
    expect(chunkFormatFilesForCommand(single, prefixArgs, 1024)).toEqual([single]);
  });
});
