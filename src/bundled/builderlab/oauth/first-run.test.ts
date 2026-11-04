import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { FederatedIdentityService } from "../../../features/federated-identity/service";
import { federatedFixture } from "../../../features/federated-identity/testing";
import type { StorageResult } from "../../../plugins/types";
import manifest from "../manifest.json";
import {
  bundledFederatedIdentity,
  bundledHost,
  firstRunCredential,
} from "./first-run";
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});
const catalog = (enabled: boolean): StorageResult => ({
  status: "ready",
  catalog: {
    profile: "default",
    location: "/profiles/default",
    plugins: [
      {
        manifest: { ...manifest, apiVersion: 1 },
        source: "bundled",
        revision: "bundled",
        enabled,
        previous: null,
        reloadable: false,
        error: null,
      },
    ],
  },
  externalPluginsPaused: false,
});

it("requests under the bundled Builderlab grant without a plugin owner", async () => {
  vi.mocked(invoke).mockResolvedValueOnce({
    status: 200,
    headers: {},
    body: "{}",
  });
  const request = { url: "https://app.builderlab.xyz/api/goose/v1/auth/me" };
  await bundledHost.request(request);
  expect(invoke).toHaveBeenCalledWith("plugin_host_request", {
    id: "block.builderlab",
    revision: "bundled",
    request,
  });
  expect(await bundledHost.runCommand("any")).toBeNull();
});

it("starts the native browser handoff at the configured build URL", async () => {
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example");
  vi.mocked(invoke).mockResolvedValueOnce(catalog(true));
  // A refused listener ends the attempt before any exchange request.
  vi.mocked(invoke).mockRejectedValueOnce("listener unavailable");
  await expect(
    firstRunCredential(new AbortController().signal),
  ).rejects.toThrow("Could not complete");
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(invoke).toHaveBeenNthCalledWith(1, "plugin_catalog");
  expect(invoke).toHaveBeenNthCalledWith(
    2,
    "oauth_callback_begin",
    expect.objectContaining({
      authorizationUrl: expect.stringMatching(
        /^https:\/\/builderlab\.example\/api\/goose\/v1\/auth\/login\?/,
      ),
      useState: true,
    }),
  );
});

// A disabled bundled plugin has no native grant, so its code exchange fails.
it.each([
  [
    "Builderlab is turned off",
    () => vi.mocked(invoke).mockResolvedValueOnce(catalog(false)),
    "Builderlab is turned off on this device, so you can't sign in with email. Enter a community address instead.",
  ],
  [
    "the plugin catalog cannot be read",
    () => vi.mocked(invoke).mockRejectedValueOnce("Plugin manager unavailable"),
    "Could not complete Builderlab sign-in. Try again.",
  ],
])(
  "refuses before opening the browser when %s",
  async (_label, answer, message) => {
    vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example");
    answer();
    await expect(
      firstRunCredential(new AbortController().signal),
    ).rejects.toThrow(new Error(message));
    expect(vi.mocked(invoke).mock.calls).toEqual([["plugin_catalog"]]);
  },
);

describe("an FI build", () => {
  const me = {
    subject: "user",
    email: " a@example.com ",
    capabilities: { can_use_remote_agents: true },
  };

  it("calls the NIP-FI forwarder as the bundled installation, before the plugin starts", async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    vi.mocked(listen).mockResolvedValue(() => {});
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "federated_identity_snapshot")
        return { ...federatedFixture().service.snapshot(), revision: "r" };
      if (command === "federated_identity_request")
        return { status: 200, headers: {}, body: "{}" };
    });
    const root = new Context();
    new FederatedIdentityService(root);
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("federated_identity_snapshot"),
    );
    const request = { path: "/api/goose/v1/auth/me", method: "GET" as const };
    await bundledFederatedIdentity(root).request(request);
    expect(invoke).toHaveBeenCalledWith("federated_identity_register", {
      id: "block.builderlab",
      revision: "bundled",
      registration: expect.any(String),
    });
    expect(invoke).toHaveBeenCalledWith("federated_identity_request", {
      id: "block.builderlab",
      revision: "bundled",
      registration: expect.any(String),
      session: "r",
      request,
    });
    await root.fiber.dispose();
  });

  it("signs in through the native session and reads its account, never opening the plugin's own browser handoff", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(catalog(true));
    const fi = federatedFixture();
    fi.request.mockResolvedValueOnce({
      status: 200,
      headers: {},
      body: JSON.stringify(me),
    });
    const credential = await firstRunCredential(
      new AbortController().signal,
      fi.service,
    );
    expect(credential).toEqual({
      value: fi.service.snapshot().revision,
      account: {
        subject: "user",
        email: "a@example.com",
        canUseRemoteAgents: true,
        canUseBuilderlabDecisions: false,
      },
    });
    expect(fi.service.signIn).toHaveBeenCalledOnce();
    expect(fi.request.mock.calls).toEqual([
      [
        {
          path: "/api/goose/v1/auth/me",
          method: "GET",
          headers: { Accept: "application/json" },
        },
      ],
    ]);
    expect(vi.mocked(invoke).mock.calls).toEqual([["plugin_catalog"]]);
  });

  it.each([
    [
      "the native sign-in did not finish",
      (fi: ReturnType<typeof federatedFixture>) =>
        vi.mocked(fi.service.signIn).mockImplementationOnce(async () => ({
          ...fi.service.snapshot(),
          failure: "sign-in-canceled",
        })),
      "Sign-in was canceled. Sign in when you’re ready.",
    ],
    [
      "a renewal of the existing session does not finish",
      (fi: ReturnType<typeof federatedFixture>) => {
        fi.publish({ status: "signed-in", revision: "existing" });
        vi.mocked(fi.service.signIn).mockImplementationOnce(async () =>
          fi.service.snapshot(),
        );
      },
      "Sign-in was canceled. Sign in when you’re ready.",
    ],
    [
      "native refuses the sign-in with a failure code",
      (fi: ReturnType<typeof federatedFixture>) =>
        vi
          .mocked(fi.service.signIn)
          .mockRejectedValueOnce(new Error("storage-busy")),
      "Secure storage is busy. Close another Buzz instance and try again.",
    ],
    [
      "the account read is not JSON",
      (fi: ReturnType<typeof federatedFixture>) =>
        fi.request.mockResolvedValueOnce({
          status: 200,
          headers: {},
          body: "<html>",
        }),
      "Could not load your Builderlab account. Try again.",
    ],
    [
      "the account read is refused",
      (fi: ReturnType<typeof federatedFixture>) =>
        fi.request.mockResolvedValueOnce({
          status: 403,
          headers: {},
          body: "",
        }),
      "Could not load your Builderlab account. Try again.",
    ],
    [
      "the session changes during the account read",
      (fi: ReturnType<typeof federatedFixture>) =>
        fi.request.mockImplementationOnce(async () => {
          fi.publish({ revision: "replaced" });
          return { status: 200, headers: {}, body: JSON.stringify(me) };
        }),
      "Could not load your Builderlab account. Try again.",
    ],
  ])("fails when %s", async (_label, arrange, message) => {
    vi.mocked(invoke).mockResolvedValueOnce(catalog(true));
    const fi = federatedFixture();
    arrange(fi);
    await expect(
      firstRunCredential(new AbortController().signal, fi.service),
    ).rejects.toThrow(new Error(message));
  });

  it("continues as the account the browser chose again for a session that already exists", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(catalog(true));
    const fi = federatedFixture();
    fi.publish({ status: "signed-in", revision: "existing" });
    fi.request.mockResolvedValueOnce({
      status: 200,
      headers: {},
      body: JSON.stringify(me),
    });
    const credential = await firstRunCredential(
      new AbortController().signal,
      fi.service,
    );
    expect(credential.value).toBe("user:1");
    expect(fi.service.signIn).toHaveBeenCalledOnce();
  });

  it("waits for the stored session to be restored, then signs in again rather than continuing as it", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(catalog(true));
    const fi = federatedFixture();
    fi.publish({ status: "restoring" });
    const subscribe = vi.spyOn(fi.service, "subscribe");
    // The renewal is canceled in the browser.
    vi.mocked(fi.service.signIn).mockImplementationOnce(async () =>
      fi.service.snapshot(),
    );
    const credential = firstRunCredential(
      new AbortController().signal,
      fi.service,
    );
    await vi.waitFor(() => expect(subscribe).toHaveBeenCalled());
    expect(fi.service.signIn).not.toHaveBeenCalled();
    fi.publish({ status: "signed-in", revision: "restored" });
    await expect(credential).rejects.toThrow(
      "Sign-in was canceled. Sign in when you’re ready.",
    );
    expect(fi.service.signIn).toHaveBeenCalledOnce();
  });

  it("cancels while waiting for the restore without signing in", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(catalog(true));
    const fi = federatedFixture();
    fi.publish({ status: "restoring" });
    const subscribe = vi.spyOn(fi.service, "subscribe");
    // Native has no sign-in to cancel yet, so nothing is published.
    vi.mocked(fi.service.cancelSignIn).mockImplementationOnce(async () => {});
    const attempt = new AbortController();
    const credential = firstRunCredential(attempt.signal, fi.service);
    await vi.waitFor(() => expect(subscribe).toHaveBeenCalled());
    attempt.abort();
    await expect(credential).rejects.toThrow("Sign-in canceled.");
    expect(fi.service.signIn).not.toHaveBeenCalled();
  });

  describe("after a failed restore", () => {
    const account = (fi: ReturnType<typeof federatedFixture>) =>
      fi.request.mockResolvedValueOnce({
        status: 200,
        headers: {},
        body: JSON.stringify(me),
      });

    it("renews a stored session that signing in restores with no browser step", async () => {
      vi.mocked(invoke).mockResolvedValueOnce(catalog(true));
      const fi = federatedFixture();
      fi.publish({ status: "unavailable", failure: "network-unavailable" });
      account(fi);
      vi.mocked(fi.service.signIn).mockImplementationOnce(async () => {
        fi.publish({ status: "signed-in", revision: "stored", failure: null });
        return fi.service.snapshot();
      });
      const credential = await firstRunCredential(
        new AbortController().signal,
        fi.service,
      );
      expect(credential.value).toBe("user:1");
      expect(fi.service.signIn).toHaveBeenCalledTimes(2);
    });

    it("continues after a browser sign-in, without renewing it", async () => {
      vi.mocked(invoke).mockResolvedValueOnce(catalog(true));
      const fi = federatedFixture();
      fi.publish({ status: "unavailable", failure: "network-unavailable" });
      account(fi);
      vi.mocked(fi.service.signIn).mockImplementationOnce(async () => {
        fi.publish({ status: "signing-in", revision: "login", failure: null });
        fi.publish({ status: "signed-in", revision: "chosen" });
        return fi.service.snapshot();
      });
      const credential = await firstRunCredential(
        new AbortController().signal,
        fi.service,
      );
      expect(credential.value).toBe("chosen");
      expect(fi.service.signIn).toHaveBeenCalledOnce();
    });

    it("fails without signing in again when the restore fails again", async () => {
      vi.mocked(invoke).mockResolvedValueOnce(catalog(true));
      const fi = federatedFixture();
      fi.publish({ status: "unavailable", failure: "network-unavailable" });
      vi.mocked(fi.service.signIn).mockImplementationOnce(async () =>
        fi.service.snapshot(),
      );
      await expect(
        firstRunCredential(new AbortController().signal, fi.service),
      ).rejects.toThrow(new Error("Sign-in did not finish. Try again."));
      expect(fi.service.signIn).toHaveBeenCalledOnce();
    });

    it("cancels a browser step that begins after Cancel found nothing to cancel, but not a newer sign-in's", async () => {
      vi.mocked(invoke).mockResolvedValueOnce(catalog(true));
      const fi = federatedFixture();
      fi.publish({ status: "unavailable", failure: "network-unavailable" });
      // Native is still restoring when Cancel arrives, so it cancels nothing.
      vi.mocked(fi.service.cancelSignIn).mockImplementationOnce(async () => {});
      let restored!: () => void;
      const restoring = new Promise<void>((resolve) => {
        restored = resolve;
      });
      let started!: () => void;
      const pending = new Promise<void>((resolve) => {
        started = resolve;
      });
      vi.mocked(fi.service.signIn).mockImplementationOnce(async () => {
        started();
        await restoring;
        // The browser step ends only when it is canceled.
        const canceled = new Promise<void>((resolve) =>
          vi
            .mocked(fi.service.cancelSignIn)
            .mockImplementationOnce(async () => resolve()),
        );
        fi.publish({ status: "signing-in", revision: "login", failure: null });
        await canceled;
        fi.publish({ status: "signed-out", failure: "sign-in-canceled" });
        const answer = fi.service.snapshot();
        // Signing in again after Cancel opens the browser before this call's
        // answer arrives.
        fi.publish({ status: "signing-in", revision: "newer", failure: null });
        return answer;
      });
      const attempt = new AbortController();
      const credential = firstRunCredential(attempt.signal, fi.service);
      await pending;
      attempt.abort();
      expect(fi.service.cancelSignIn).toHaveBeenCalledOnce();
      const canceled = expect(credential).rejects.toThrow("Sign-in canceled.");
      restored();
      await vi.waitFor(() =>
        expect(fi.service.cancelSignIn).toHaveBeenCalledTimes(2),
      );
      await canceled;
      expect(fi.service.cancelSignIn).toHaveBeenCalledTimes(2);
    });
  });

  it("cancels the native sign-in when first run cancels", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(catalog(true));
    const fi = federatedFixture();
    let started!: () => void;
    const pending = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.mocked(fi.service.signIn).mockImplementationOnce(async () => {
      fi.publish({ status: "signing-in", revision: "login" });
      started();
      await new Promise<void>((resolve) =>
        vi
          .mocked(fi.service.cancelSignIn)
          .mockImplementationOnce(async () => resolve()),
      );
      fi.publish({ status: "signed-out", failure: "sign-in-canceled" });
      const answer = fi.service.snapshot();
      // Signing in again after Cancel opens the browser before this call's
      // answer arrives.
      fi.publish({ status: "signing-in", revision: "newer" });
      return answer;
    });
    const attempt = new AbortController();
    const credential = firstRunCredential(attempt.signal, fi.service);
    await pending;
    attempt.abort();
    await expect(credential).rejects.toThrow("Sign-in canceled.");
    expect(fi.service.cancelSignIn).toHaveBeenCalledOnce();
    expect(fi.request).not.toHaveBeenCalled();
  });
});

it("saves first run's browser sign-in as the plugin's session, now and after a restart", async () => {
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://app.builderlab.xyz");
  // Native keys the item by the build's Builderlab, which each call names.
  const items = new Map<unknown, string>();
  const me = JSON.stringify({ subject: "user", email: "a@example.com" });
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const input = args as Record<string, unknown> | undefined;
    switch (command) {
      case "plugin_catalog":
        return catalog(true);
      case "oauth_callback_begin":
        return { id: "a", callbackUrl: "http://127.0.0.1:1/cb" };
      case "oauth_callback_wait":
        return { parameters: [["code", "code"]] };
      case "builderlab_session_save":
        items.set(input?.target, input?.value as string);
        return undefined;
      case "builderlab_session_load":
        return items.get(input?.target) ?? null;
      case "plugin_host_request": {
        const { url } = (input as { request: { url: string } }).request;
        return url.endsWith("/exchange")
          ? { status: 200, headers: {}, body: '{"session_credential":"token"}' }
          : { status: 200, headers: {}, body: me };
      }
      default:
        return undefined;
    }
  });
  const { createOAuthSession } = await import("./session");
  const { onCredentialSaved, restoredCredential, savedCredential } =
    await import("./browser");
  const plugin = () => {
    const acquire = vi.fn(async () => {
      throw new Error("asked again");
    });
    const session = createOAuthSession(acquire, undefined, bundledHost, {
      restore: (signal) => restoredCredential(bundledHost, signal),
      save: (credential) => savedCredential.save(credential.value),
      clear: () => savedCredential.clear(),
      watch: onCredentialSaved,
    });
    return { session, acquire };
  };
  // The plugin is already running, signed out, while first run signs in.
  const running = plugin();
  await vi.waitFor(() =>
    expect(running.session.snapshot().status).toBe("signed-out"),
  );
  const credential = await firstRunCredential(new AbortController().signal);
  expect(credential.value).toBe("token");
  expect([...items]).toEqual([
    ["https://app.builderlab.xyz/api/goose", "token"],
  ]);
  await vi.waitFor(() =>
    expect(running.session.snapshot().status).toBe("signed-in"),
  );
  running.session.dispose();
  // A restart: a new plugin session restores it without asking.
  const restarted = plugin();
  await vi.waitFor(() =>
    expect(restarted.session.snapshot()).toMatchObject({
      status: "signed-in",
      account: { subject: "user" },
    }),
  );
  expect(restarted.session.credential().value).toBe("token");
  expect(running.acquire).not.toHaveBeenCalled();
  expect(restarted.acquire).not.toHaveBeenCalled();
  restarted.session.dispose();
  // A build for another Builderlab never reads or sends this one.
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example");
  const other = plugin();
  await vi.waitFor(() =>
    expect(other.session.snapshot()).toEqual({ status: "signed-out" }),
  );
  const urls = vi
    .mocked(invoke)
    .mock.calls.filter(([command]) => command === "plugin_host_request")
    .map(([, input]) => (input as { request: { url: string } }).request.url);
  expect(urls.some((url) => url.startsWith("https://builderlab.example"))).toBe(
    false,
  );
  other.session.dispose();
});
