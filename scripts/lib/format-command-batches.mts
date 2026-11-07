// Keep formatter arguments bounded even when pnpm joins them into one shell command.
const FORMAT_MAX_COMMAND_LINE_BYTES = 24 * 1024;
// Both callers reach the formatter through a .cmd shim on Windows, so the whole
// batch ends up inside a single `cmd.exe /d /s /c "..."` argument. cmd.exe
// truncates that argument at 8191 characters, which silently drops the tail of
// a large batch, so the Windows default stays under it with room for the
// interpreter path and the quoting that wrapping adds.
const FORMAT_MAX_CMD_EXE_COMMAND_LINE_BYTES = 7 * 1024;

export function defaultFormatCommandLineBytes(platform: string = process.platform) {
  return platform === "win32"
    ? FORMAT_MAX_CMD_EXE_COMMAND_LINE_BYTES
    : FORMAT_MAX_COMMAND_LINE_BYTES;
}

function commandLineBytes(args: string[]) {
  return args.reduce((total, arg) => total + Buffer.byteLength(arg, "utf8") + 3, 0);
}

export function chunkFormatFilesForCommand(
  files: string[],
  prefixArgs: string[],
  maxBytes = defaultFormatCommandLineBytes(),
) {
  const chunks: string[][] = [];
  let chunk: string[] = [];
  let chunkBytes = commandLineBytes(prefixArgs);

  for (const file of files) {
    const fileBytes = Buffer.byteLength(file, "utf8") + 3;
    if (chunk.length > 0 && chunkBytes + fileBytes > maxBytes) {
      chunks.push(chunk);
      chunk = [];
      chunkBytes = commandLineBytes(prefixArgs);
    }
    chunk.push(file);
    chunkBytes += fileBytes;
  }

  if (chunk.length > 0) {
    chunks.push(chunk);
  }

  return chunks;
}
