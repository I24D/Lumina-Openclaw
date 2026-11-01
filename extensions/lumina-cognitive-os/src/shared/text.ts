/**
 * Text form of an untyped value from JSON, tool input or a sidecar message.
 * Strings pass through, numbers/booleans/bigints are stringified, and anything
 * else (missing values, objects, arrays) yields the fallback instead of
 * "[object Object]".
 */
export function textOf(value: unknown, fallback = ""): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return fallback;
}
