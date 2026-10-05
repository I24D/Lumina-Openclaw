/**
 * perception-bridge.ts — Plugs screen perception into the thalamic router.
 *
 * The plugin's perception sidecar already watches the screen (window in
 * front, large visual changes, its own errors). This adapter turns those into
 * catalogued events, the way awareness-bridge.ts does for the environment, so
 * the cognitive core "sees the screen" (M3GAN VIRTUAL, spec §87) through the
 * same door as every other sense.
 *
 * Window titles and screen content can come from web pages and other people's
 * messages, so screen events are UNTRUSTED (spec §101): they inform the
 * workspace and the world, and the loop never executes an action they prompt.
 * Heartbeats and lifecycle events are not cognition and are not forwarded;
 * sidecar errors become subsystem health events.
 */
import { m3ganEvent } from "../../events/catalog.js";
import type { PerceptionEvent } from "../../perception/perception-process.js";
import type { ThalamicRouter } from "../router/thalamic-router.js";

/** Smaller visual changes than this are noise, not events. */
export const SCREEN_CHANGE_THRESHOLD = 0.25;

export function attachScreenPerception(
  bus: { on(listener: (event: PerceptionEvent) => void): () => void },
  router: Pick<ThalamicRouter, "ingest">,
  options: { readonly onError?: (error: unknown) => void } = {},
): () => void {
  return bus.on((ev) => {
    try {
      switch (ev.kind) {
        case "foreground":
          router.ingest(
            m3ganEvent(
              "screen",
              "screen.foreground",
              { process: ev.process, title: ev.title },
              {
                atISO: ev.atISO,
                trust: "untrusted",
              },
            ),
          );
          break;
        case "frame":
          if (ev.changedRatio >= SCREEN_CHANGE_THRESHOLD) {
            router.ingest(
              m3ganEvent(
                "screen",
                "screen.changed",
                { changedRatio: Math.min(1, ev.changedRatio) },
                {
                  atISO: ev.atISO,
                  trust: "untrusted",
                },
              ),
            );
          }
          break;
        case "error":
          router.ingest(
            m3ganEvent(
              "screen",
              "subsystem.health",
              { subsystem: "screen-perception", status: "degraded", detail: ev.message },
              { atISO: ev.atISO },
            ),
          );
          break;
        default:
          break;
      }
    } catch (error) {
      options.onError?.(error);
    }
  });
}
