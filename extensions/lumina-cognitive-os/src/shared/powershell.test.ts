/**
 * Tests for the PowerShell JSON pipeline.
 */
import { describe, expect, it } from "vitest";
import { jsonPipeline } from "./powershell.js";

describe("jsonPipeline", () => {
  it("never starts a line with a pipe, which Windows PowerShell 5.1 rejects", () => {
    const script = jsonPipeline("Get-NetAdapter | Select-Object Name");
    for (const line of script.split("\n")) {
      expect(line.trimStart().startsWith("|")).toBe(false);
    }
    expect(script).toBe(
      "& {\nGet-NetAdapter | Select-Object Name\n} | ConvertTo-Json -Depth 8 -Compress",
    );
  });

  it("keeps a multi-statement script whole inside one block", () => {
    const script = jsonPipeline("$a = 1\n$b = 2\n[pscustomobject]@{ sum = $a + $b }");
    expect(script.startsWith("& {\n$a = 1")).toBe(true);
    expect(script.endsWith("\n} | ConvertTo-Json -Depth 8 -Compress")).toBe(true);
  });
});
