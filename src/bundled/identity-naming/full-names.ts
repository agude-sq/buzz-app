import type { NamingIdentity } from "../../features/identity-names/policy";
import type { VerifiedProfile } from "../../features/relay/verified-profile";

const preferenceKey = "buzz-identity-naming-full-names.v1";

// Swap names before resolving, so the naming rules still tell namesakes apart.
export function withFullNames(
  identities: readonly NamingIdentity[],
): NamingIdentity[] {
  return identities.map((identity) => {
    // The directory passes each identity's profile, verified names included.
    const { verified } = identity as { verified?: VerifiedProfile };
    const fullName = !identity.isAgent && verified?.fullName?.trim();
    return fullName ? { ...identity, name: fullName } : identity;
  });
}

export function createFullNamesPreference(storage?: Storage) {
  let enabled = false;
  try {
    enabled = storage?.getItem(preferenceKey) === "on";
  } catch {}
  const listeners = new Set<() => void>();
  return {
    snapshot: () => enabled,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(next: boolean) {
      if (next === enabled) return;
      enabled = next;
      try {
        storage?.setItem(preferenceKey, next ? "on" : "off");
      } catch {
        // The choice still applies until Buzz restarts.
      }
      for (const listener of listeners) listener();
    },
  };
}
export type FullNamesPreference = ReturnType<typeof createFullNamesPreference>;
