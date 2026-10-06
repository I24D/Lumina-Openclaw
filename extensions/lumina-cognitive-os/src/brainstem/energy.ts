/**
 * energy.ts — What the battery level means for what the body may do.
 *
 * Lumina spec §32: know the charge, the draw and where the charger is; on low
 * battery reach a safe state, go to the charger and charge. This is the pure
 * policy; the brainstem applies it and the safety supervisor already refuses
 * motion at critical charge (anything but charging or stopping).
 */

export type EnergyLevel = "unknown" | "ok" | "low" | "critical";

export type EnergyAdvice = {
  readonly level: EnergyLevel;
  /** none: carry on · conserve: avoid optional motion · go_charge: head to the charger · safe_state: stop and wait */
  readonly action: "none" | "conserve" | "go_charge" | "safe_state";
  readonly detail: string;
};

export const LOW_BATTERY_PERCENT = 20;
export const CRITICAL_BATTERY_PERCENT = 5;

export function assessEnergy(params: {
  readonly battery: { readonly percent: number; readonly charging: boolean } | null;
  readonly hasBody: boolean;
  /** A charging station the world model knows. */
  readonly chargerId?: string;
}): EnergyAdvice {
  const { battery, hasBody, chargerId } = params;
  if (!battery) {
    return {
      level: "unknown",
      action: "none",
      detail: "No battery reported (mains power or no sensor).",
    };
  }
  if (battery.charging) {
    return { level: "ok", action: "none", detail: `Charging at ${battery.percent}%.` };
  }
  if (battery.percent <= CRITICAL_BATTERY_PERCENT) {
    return {
      level: "critical",
      action: hasBody ? (chargerId ? "go_charge" : "safe_state") : "safe_state",
      detail: hasBody
        ? chargerId
          ? `Battery at ${battery.percent}%: only the trip to ${chargerId} and stopping are allowed.`
          : `Battery at ${battery.percent}% and no known charger: stop and wait for a person.`
        : `Battery at ${battery.percent}%: save work; the computer may shut down.`,
    };
  }
  if (battery.percent <= LOW_BATTERY_PERCENT) {
    return {
      level: "low",
      action: hasBody && chargerId ? "go_charge" : "conserve",
      detail: `Battery at ${battery.percent}% and not charging.`,
    };
  }
  return { level: "ok", action: "none", detail: `Battery at ${battery.percent}%.` };
}
