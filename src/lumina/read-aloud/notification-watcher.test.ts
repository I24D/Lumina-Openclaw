import { describe, expect, it } from "vitest";
import {
  buildNotificationSpeech,
  matchesNotificationApp,
  resolveNotificationAppMatchers,
} from "./notification-watcher.js";

const PHONE_LINK = {
  id: "1|Microsoft.YourPhone_8wekyb3d8bbwe!App|2026-08-30",
  appName: "Enlace móvil",
  appUserModelId: "Microsoft.YourPhone_8wekyb3d8bbwe!App",
  title: "Ana",
  body: "¿Llegas a las siete?",
};

describe("read-aloud notification filtering", () => {
  it("defaults to the messaging apps the user asked for", () => {
    const matchers = resolveNotificationAppMatchers(undefined);
    expect(matchers).not.toBe("all");
    expect(matchesNotificationApp(PHONE_LINK, matchers)).toBe(true);
    expect(
      matchesNotificationApp(
        {
          appName: "Microsoft Edge",
          appUserModelId: "Microsoft.MicrosoftEdge.Stable_8wekyb3d8bbwe!App",
        },
        matchers,
      ),
    ).toBe(false);
  });

  it("matches Phone Link by display name in either language", () => {
    const matchers = resolveNotificationAppMatchers(undefined);
    expect(matchesNotificationApp({ appName: "Phone Link" }, matchers)).toBe(true);
    expect(matchesNotificationApp({ appName: "Enlace movil" }, matchers)).toBe(true);
  });

  it("honours an explicit allowlist and the wildcard", () => {
    expect(
      matchesNotificationApp({ appName: "Microsoft Edge" }, resolveNotificationAppMatchers("edge")),
    ).toBe(true);
    expect(
      matchesNotificationApp({ appName: "Anything" }, resolveNotificationAppMatchers("*")),
    ).toBe(true);
    expect(
      matchesNotificationApp(
        { appName: "Microsoft Edge" },
        resolveNotificationAppMatchers("teams"),
      ),
    ).toBe(false);
  });

  it("speaks the app, the sender and the message body", () => {
    expect(buildNotificationSpeech(PHONE_LINK)).toBe("Enlace móvil. Ana: ¿Llegas a las siete?");
    expect(buildNotificationSpeech({ appName: "WhatsApp", title: "Nuevo mensaje" })).toBe(
      "WhatsApp. Nuevo mensaje",
    );
    expect(buildNotificationSpeech({})).toBe("Notificación");
  });
});
