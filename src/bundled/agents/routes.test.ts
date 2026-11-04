import { expect, it } from "vitest";
import {
  agentAttentionDialogRoute,
  agentAttentionDialogTarget,
  agentProviderRoute,
  agentProviderTarget,
  agentRoute,
  agentTarget,
  availableAgentProviderRoute,
} from "./routes";

it("admits provider-shaped routes and preserves the Agents page scope", () => {
  const route = { provider: "test/echo" };
  expect(agentProviderRoute(route)).toBe("test/echo");
  expect(availableAgentProviderRoute(route)).toBe(true);
  expect(availableAgentProviderRoute({ provider: "test/gone" })).toBe(true);
  for (const invalid of [
    null,
    "test/echo",
    { provider: "echo" },
    { provider: "test/echo", extra: true },
  ] as const)
    expect(agentProviderRoute(invalid)).toBeUndefined();

  const base = {
    version: 1,
    kind: "page",
    pluginId: "buzz.agents",
    pageId: "agents",
    scope: null,
  } as const;
  const opened = agentProviderTarget(base, "test/echo");
  expect(opened).toEqual({
    ...base,
    route: { version: 1, params: route },
  });
  expect(agentProviderTarget(opened)).toEqual(base);
});

it("admits an agent of yours to open, by its key", () => {
  const pubkey = "a".repeat(64);
  expect(agentRoute(agentTarget(pubkey).route.params)).toBe(pubkey);
  expect(availableAgentProviderRoute({ agent: pubkey })).toBe(true);
  for (const invalid of [
    { agent: "Ada" },
    { agent: pubkey, provider: "test/echo" },
    { agent: 1 },
  ] as const)
    expect(agentRoute(invalid)).toBeUndefined();
  expect(agentProviderRoute({ agent: pubkey })).toBeUndefined();
});

it("admits an Attention source's dialog and closes it on the same page", () => {
  const route = { attention: "attention/github-pr", dialog: "authors" };
  expect(agentAttentionDialogRoute(route)).toEqual({
    provider: "attention/github-pr",
    id: "authors",
  });
  expect(availableAgentProviderRoute(route)).toBe(true);
  for (const invalid of [
    { attention: "attention/github-pr" },
    { attention: "github", dialog: "authors" },
    { attention: "attention/github-pr", dialog: "Authors!" },
    { ...route, agent: "a".repeat(64) },
  ] as const)
    expect(agentAttentionDialogRoute(invalid)).toBeUndefined();
  expect(agentProviderRoute(route)).toBeUndefined();

  const base = {
    version: 1,
    kind: "page",
    pluginId: "buzz.agents",
    pageId: "agents",
    scope: null,
  } as const;
  const opened = agentAttentionDialogTarget(base, {
    provider: "attention/github-pr",
    id: "authors",
  });
  expect(opened).toEqual({ ...base, route: { version: 1, params: route } });
  expect(agentAttentionDialogTarget(opened)).toEqual(base);
});
