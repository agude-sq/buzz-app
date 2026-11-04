// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import { createNameProvider } from "../../features/identity-names/directory";
import {
  bindNames,
  type NameSource,
  type NamingPolicy,
} from "../../features/identity-names/service";
import type { Profile } from "../../features/relay/contracts";
import type { SettingsCard } from "../../features/settings/service";
import { apply } from "./index";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const person = "a".repeat(64),
  namesake = "b".repeat(64),
  agent = "c".repeat(64);
const verified = (fullName: string) => ({
  displayName: "",
  username: "",
  fullName,
  issuerLabel: "Block",
  verifiedAt: 1,
  status: "checked" as const,
  multipleIssuers: false,
});
const profiles = new Map<string, Profile>([
  [person, { name: "agude", verified: verified("Alexander Gude") }],
  [namesake, { name: "agude2", verified: verified("Alexander Gude") }],
  [agent, { name: "Honey", isAgent: true, verified: verified("Not Honey") }],
]);
const source: NameSource = {
  profiles: {
    snapshot: () => profiles,
    subscribe: () => () => {},
    ensure: async () => {},
  },
  agentLibrary: {
    snapshot: () => ({ status: "ready", definitions: [], identities: [] }),
    subscribe: () => () => {},
    refresh: async () => {},
    retain: () => () => {},
  },
};

function load() {
  let policy: NamingPolicy | undefined;
  let card: SettingsCard | undefined;
  const ctx = {
    identityNames: { register: (next: NamingPolicy) => (policy = next) },
    inject: (_: string[], use: (scope: unknown) => void) =>
      use({
        settingsCards: { register: (next: SettingsCard) => (card = next) },
      }),
  };
  apply(ctx as unknown as Context);
  if (!policy || !card) throw new Error("Identity Naming did not register");
  const provider = createNameProvider(policy);
  const names = bindNames(source, {
    snapshot: () => [provider],
    subscribe: () => () => {},
  });
  const Settings = card.component;
  render(<Settings active={() => true} />);
  return { names, toggle: () => fireEvent.click(screen.getByRole("switch")) };
}

it("names people by their verified full names once the setting is on", () => {
  const { names, toggle } = load();
  const candidates = [person, agent];
  expect(names.resolve(person, undefined, candidates)).toBe("agude");
  const changed = vi.fn();
  names.subscribe(changed);
  toggle();
  expect(changed).toHaveBeenCalled();
  expect(names.resolve(person, undefined, candidates)).toBe("Alexander Gude");
  expect(names.resolve(agent, undefined, candidates)).toBe("Honey");
  expect(names.resolve(person, undefined, [person, namesake])).toMatch(
    /^Alexander Gude · /,
  );
  toggle();
  expect(names.resolve(person, undefined, candidates)).toBe("agude");
});

it("remembers the setting on this device", () => {
  load().toggle();
  cleanup();
  const { names } = load();
  expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
  expect(names.resolve(person, undefined, [person])).toBe("Alexander Gude");
});
