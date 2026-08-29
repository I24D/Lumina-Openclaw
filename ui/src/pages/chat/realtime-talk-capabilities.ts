import { DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS } from "@openclaw/gateway-client/browser";
import type { TalkCatalogResult } from "@openclaw/gateway-protocol";
import type { GatewayBrowserClient } from "../../api/gateway.ts";

export async function resolveRealtimeTalkVideoCapability(
  client: GatewayBrowserClient,
  requestedProvider: string | undefined,
): Promise<boolean> {
  try {
    const catalog = await client.request<TalkCatalogResult>(
      "talk.catalog",
      {},
      { timeoutMs: DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS },
    );
    const selectedProvider = requestedProvider ?? catalog.realtime.activeProvider;
    if (!selectedProvider) {
      return false;
    }
    return (
      catalog.realtime.providers.find(
        (provider) =>
          provider.id === selectedProvider || provider.aliases?.includes(selectedProvider),
      )?.supportsVideoFrames === true
    );
  } catch {
    return false;
  }
}
