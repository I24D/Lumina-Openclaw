/**
 * gateway-methods.ts — The owner channel as gateway RPC methods.
 *
 * The Control UI's M3GAN tab renders natively and calls these over its
 * authenticated gateway session, like the Logbook tab. Reads need
 * operator.read; every command needs operator.write. The state is the
 * process-wide cognitive core, so no method touches a user's profile.
 */
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  ErrorCodes,
  errorShape,
  type GatewayRequestHandlerOptions,
} from "openclaw/plugin-sdk/gateway-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  createOwnerCommands,
  m3ganState,
  OwnerChannelError,
  type OwnerChannelDeps,
} from "./owner-channel.js";

function handler(run: (params: Readonly<Record<string, unknown>>) => unknown) {
  return async ({ params, respond }: GatewayRequestHandlerOptions) => {
    try {
      respond(true, await run(params ?? {}));
    } catch (error) {
      const message = formatErrorMessage(error);
      const code =
        error instanceof OwnerChannelError ? ErrorCodes.INVALID_REQUEST : ErrorCodes.UNAVAILABLE;
      respond(false, { error: message }, errorShape(code, message));
    }
  };
}

export function registerM3ganGatewayMethods(
  api: Pick<OpenClawPluginApi, "registerGatewayMethod">,
  deps: OwnerChannelDeps,
): void {
  const options = (scope: "operator.read" | "operator.write") =>
    ({ scope, profileAccess: "independent" }) as const;
  api.registerGatewayMethod(
    "m3gan.state",
    handler(() => m3ganState(deps)),
    options("operator.read"),
  );
  api.registerGatewayMethod(
    "m3gan.audit.verify",
    handler(() => deps.runtime.safety.verifyStoredAudit()),
    options("operator.read"),
  );
  for (const [method, run] of Object.entries(createOwnerCommands(deps))) {
    api.registerGatewayMethod(method, handler(run), options("operator.write"));
  }
}
