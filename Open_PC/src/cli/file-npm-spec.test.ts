import { describe, expect, it } from "vitest";
import { resolveFileNpmSpecToLocalPath } from "./file-npm-spec.js";

describe("resolveFileNpmSpecToLocalPath", () => {
  it("ignores non-file specs", () => {
    expect(resolveFileNpmSpecToLocalPath("@scope/pkg")).toBeNull();
  });

  it("supports common local file variants", () => {
    expect(resolveFileNpmSpecToLocalPath("file:./plugin")).toEqual({
      ok: true,
      path: "./plugin",
    });
    expect(resolveFileNpmSpecToLocalPath("file:///C:/plugin")).toEqual({
      ok: true,
      path: "/C:/plugin",
    });
    expect(resolveFileNpmSpecToLocalPath("file://localhost/C:/plugin")).toEqual({
      ok: true,
      path: "/C:/plugin",
    });
  });

  it("rejects remote file hosts", () => {
    expect(resolveFileNpmSpecToLocalPath("file://server/share")).toEqual({
      ok: false,
      error: 'unsupported file: URL host (expected "file:<path>" or "file:///abs/path")',
    });
  });
});
