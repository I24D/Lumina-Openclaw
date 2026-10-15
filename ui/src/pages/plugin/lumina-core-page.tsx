import type { JSX } from "@solidjs/web";
import { createSignal } from "solid-js";
import { createLitContentRef } from "../../lit/solid-bridge.ts";
import type { LogbookProps } from "./logbook-view.tsx";
import { renderLuminaCore } from "./lumina-core-view.ts";

/** Mounts the Lit Lumina core view inside the Solid plugin page. */
export function LuminaCore(props: LogbookProps): JSX.Element {
  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  const ref = createLitContentRef(() => {
    revision();
    return renderLuminaCore({
      host: props.host,
      client: props.client,
      connected: props.connected,
      onRequestUpdate: () => setRevision((value) => value + 1),
    });
  });
  return <div ref={ref} style={{ display: "contents" }} />;
}
