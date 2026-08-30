// Control UI tests assert default-locale (English) strings. The i18n manager
// picks its initial locale from `navigator.language`, and under the `node`
// test environment that value comes from the host's ICU locale rather than
// from jsdom's fixed "en-US" — so on a non-English machine every assertion on
// a translated string fails. Pin the navigator language before any module
// reads it so the suite is independent of the developer's system locale.
import { DEFAULT_LOCALE } from "../i18n/lib/registry.ts";

const pinned = DEFAULT_LOCALE;

function pinNavigatorLanguage(): void {
  const nav = globalThis.navigator as Navigator | undefined;
  if (!nav) {
    return;
  }
  for (const [property, value] of [
    ["language", pinned],
    ["languages", Object.freeze([pinned])],
  ] as const) {
    try {
      Object.defineProperty(nav, property, {
        configurable: true,
        get: () => value,
      });
    } catch {
      // A frozen navigator keeps whatever the environment provided.
    }
  }
}

pinNavigatorLanguage();
