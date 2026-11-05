import { expect, it } from "vitest";
import type { ComposerSession } from "../../features/messages/composer-session";
import {
  bindNames,
  type NameSource,
} from "../../features/identity-names/service";
import { createAgentDirectory } from "../../features/identity-names/testing";
import { createNameProvider } from "../../features/identity-names/directory";
import { resolveIdentityNames } from "../../features/identity-names/policy";
import { withFullNames } from "../identity-naming/full-names";
import { mentionMatch } from "./mention-ranking";
import { namedCandidates } from "./use-mention-choices";

const key = (n: number) => n.toString(16).padStart(64, "0");

// Identity Naming's rule with Prefer verified full names on.
const fullNames = createNameProvider({
  id: "human-first",
  resolve: (identities, viewer, candidates) =>
    resolveIdentityNames(withFullNames(identities), viewer, candidates),
});
const verified = {
  displayName: "fname",
  username: "fname",
  fullName: "Fake Name",
  issuerLabel: "Block",
  verifiedAt: 1,
  status: "checked" as const,
  multipleIssuers: false,
};

it.each([
  ["no naming policy", undefined, "fname"],
  ["the default naming policy", [createAgentDirectory()], "fname"],
  ["a full-name naming policy", [fullNames], "Fake Name"],
])(
  "labels a person by their verified names, not the cached profile name, with %s",
  (_, policies, label) => {
    // Their kind-0 profile is cached; the community verified them as fname.
    const profiles = new Map([[key(8), { name: "fak" }]]);
    const names = bindNames(
      {
        profiles: {
          snapshot: () => profiles,
          subscribe: () => () => {},
        },
        agentLibrary: {
          snapshot: () => ({
            status: "ready",
            definitions: [],
            identities: [],
          }),
          subscribe: () => () => {},
          refresh: async () => {},
          retain: () => () => {},
        },
      } as unknown as NameSource,
      policies && { snapshot: () => policies, subscribe: () => () => {} },
    );
    const session = {
      viewer: key(1),
      names,
      channels: {
        list: () => ({
          status: "ready",
          channels: [
            { id: "c", name: "C", channelType: "stream", members: [key(1)] },
          ],
        }),
      },
      agentChoices: { snapshot: () => ({ identities: [] }) },
      profiles: { snapshot: () => profiles },
      archives: { snapshot: () => ({ status: "ready", archived: [] }) },
      outbox: { supports: () => true },
    } as unknown as ComposerSession;
    const choices = namedCandidates(
      session,
      "c",
      false,
      undefined,
      [],
      [
        {
          pubkey: key(8),
          name: "fname",
          fullName: "Fake Name",
          verified,
          profileNames: ["fak"],
        },
      ],
    );
    const fake = choices.find((choice) => choice.recipient.pubkey === key(8));
    expect(fake).toMatchObject({
      label,
      recipient: { name: "fname" },
      fullName: "Fake Name",
    });
    // Whatever the label, the verified name still finds them.
    if (!fake) throw new Error("no choice for the verified person");
    expect(mentionMatch(fake, "fname")).toBeLessThan(Infinity);
    names.dispose();
  },
);
