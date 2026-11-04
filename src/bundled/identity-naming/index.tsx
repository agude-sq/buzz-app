import { useSyncExternalStore } from "react";
import type { PluginModule } from "../../plugins/api";
import { resolveIdentityNames } from "../../features/identity-names/policy";
import { UserIcon } from "../../shared/design-system/icons";
import { Header } from "../../shared/design-system/ui/Header";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { SwitchPreferenceRow } from "../../shared/design-system/ui/SwitchPreferenceRow";
import {
  createFullNamesPreference,
  type FullNamesPreference,
  withFullNames,
} from "./full-names";

export const inject = ["identityNames"];
export const apply: PluginModule["apply"] = (ctx) => {
  let storage: Storage | undefined;
  try {
    storage = globalThis.localStorage;
  } catch {}
  const fullNames = createFullNamesPreference(storage);
  ctx.identityNames.register({
    id: "human-first",
    resolve: (identities, viewer, candidates) =>
      resolveIdentityNames(
        fullNames.snapshot() ? withFullNames(identities) : identities,
        viewer,
        candidates,
      ),
    subscribe: fullNames.subscribe,
  });
  ctx.inject(["settingsCards"], (scope) => {
    scope.settingsCards.register({
      id: "names",
      title: "Identity Naming",
      group: "Plugins",
      icon: UserIcon,
      component: ({ active }) => (
        <NamingSettings fullNames={fullNames} active={active} />
      ),
    });
  });
};

function NamingSettings({
  fullNames,
  active,
}: {
  fullNames: FullNamesPreference;
  active(): boolean;
}) {
  const enabled = useSyncExternalStore(fullNames.subscribe, fullNames.snapshot);
  return (
    <section aria-label="Identity Naming settings">
      <Header title="Identity Naming" />
      <SettingsGroup>
        <SwitchPreferenceRow
          label="Prefer verified full names"
          description="Shows people by the full name their community verified, such as “Alexander Gude” instead of “agude”. Agents keep their own names."
          checked={enabled}
          onCheckedChange={(checked) => {
            if (active()) fullNames.set(checked);
          }}
        />
      </SettingsGroup>
    </section>
  );
}
