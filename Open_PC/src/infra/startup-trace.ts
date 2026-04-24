const STARTUP_TRACE_EPOCH = process.hrtime.bigint();

function isTruthyEnvValue(value?: string): boolean {
  if (typeof value !== "string") {
    return false;
  }
  switch (value.trim().toLowerCase()) {
    case "1":
    case "on":
    case "true":
    case "yes":
      return true;
    default:
      return false;
  }
}

function shouldTraceStartup(): boolean {
  return isTruthyEnvValue(process.env.OPENCLAW_STARTUP_TRACE);
}

function formatDetails(details?: Record<string, unknown>): string {
  if (!details) {
    return "";
  }
  const filtered = Object.fromEntries(
    Object.entries(details).filter(([, value]) => value !== undefined),
  );
  if (Object.keys(filtered).length === 0) {
    return "";
  }
  try {
    return ` ${JSON.stringify(filtered)}`;
  } catch {
    return "";
  }
}

export function traceStartup(label: string, details?: Record<string, unknown>): void {
  if (!shouldTraceStartup()) {
    return;
  }
  const elapsedMs = Number(process.hrtime.bigint() - STARTUP_TRACE_EPOCH) / 1_000_000;
  process.stderr.write(
    `[openclaw-startup +${elapsedMs.toFixed(1)}ms pid=${process.pid}] ${label}${formatDetails(details)}\n`,
  );
}
