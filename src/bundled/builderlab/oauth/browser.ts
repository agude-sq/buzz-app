import { invoke, isTauri } from "@tauri-apps/api/core";
import type { Host } from "../../../features/host/service";

export const browserLoginAvailable = () => isTauri();

/** The configured HTTPS origin is granted to this plugin at build time. */
export function oauthTarget(
  value = import.meta.env.VITE_BUZZ_BUILDERLAB_URL ?? "",
) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      "Builderlab sign-in is not configured for this Buzz build.",
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.href.includes("?") ||
    url.href.includes("#")
  )
    throw new Error(
      "This Buzz build does not support the configured Builderlab sign-in address.",
    );
  return `${url.href.replace(/\/$/, "")}/api/goose`;
}

export type Credential = Readonly<{
  value: string;
  account: Readonly<{
    subject: string;
    email: string;
    canUseRemoteAgents: boolean;
    canUseBuilderlabDecisions: boolean;
  }>;
}>;

export type OAuthCallback = Readonly<{
  parameters: readonly (readonly [string, string])[];
}>;
export type BrowserBridge = {
  begin(options: {
    authorizationUrl: string;
    callbackPath: string;
    useState?: boolean;
  }): Promise<{ id: string; callbackUrl: string }>;
  wait(id: string): Promise<OAuthCallback>;
  cancel(id: string): Promise<void>;
  complete(id: string): Promise<void>;
};
const nativeBridge: BrowserBridge = {
  begin: (options) => invoke("oauth_callback_begin", options),
  wait: (id) => invoke("oauth_callback_wait", { id }),
  cancel: (id) => invoke("oauth_callback_cancel", { id }),
  complete: (id) => invoke("oauth_callback_complete", { id }),
};

function base64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Acquire and verify a credential. No UI, storage, or authenticated API consumers. */
export async function browserCredential(
  host: Host,
  signal: AbortSignal,
  bridge: BrowserBridge = nativeBridge,
): Promise<Credential> {
  signal.throwIfAborted();
  const target = oauthTarget();
  let id: string | undefined;
  let completion: Promise<void> | undefined;
  const path = `/callback/${crypto.randomUUID()}`;
  const login = new URL(`${target}/v1/auth/login`);
  const cancel = () => {
    if (id) void bridge.cancel(id).catch(() => {});
  };
  try {
    const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(verifier),
    );
    signal.throwIfAborted();
    login.search = new URLSearchParams({
      type: "cli",
      product: "builderlab",
      code_challenge: base64url(new Uint8Array(digest)),
      code_challenge_method: "S256",
    }).toString();
    const attempt = await bridge.begin({
      authorizationUrl: login.href,
      callbackPath: path,
      useState: true,
    });
    id = attempt.id;
    signal.addEventListener("abort", cancel, { once: true });
    signal.throwIfAborted();
    const response = await bridge.wait(id);
    signal.throwIfAborted();
    const parameters = new URLSearchParams(
      response.parameters.map(([name, value]) => [name, value]),
    );
    if (parameters.has("error"))
      throw new Error("Browser sign-in failed. Try again.");
    const codes = parameters.getAll("code");
    const code = codes[0];
    if (codes.length !== 1 || !code || code.length > 4096)
      throw new Error("Invalid Builderlab callback code.");
    const request = async (
      path: string,
      credential?: string,
      body?: string,
    ) => {
      signal.throwIfAborted();
      const response = await host.request({
        url: `${target}${path}`,
        method: body ? "POST" : "GET",
        headers: {
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...(credential ? { "X-BB-Session-Credential": credential } : {}),
        },
        ...(body ? { body } : {}),
      });
      signal.throwIfAborted();
      if (response.status < 200 || response.status >= 300)
        throw new Error(
          `Builderlab sign-in failed (HTTP ${response.status}). Try again.`,
        );
      try {
        return JSON.parse(response.body);
      } catch {
        throw new Error("Builderlab returned an invalid sign-in response.");
      }
    };
    const exchange = await request(
      "/v1/auth/login/exchange",
      undefined,
      JSON.stringify({ code, code_verifier: verifier }),
    );
    const session_credential = exchange?.session_credential;
    if (
      typeof session_credential !== "string" ||
      !session_credential ||
      session_credential.length > 4096 ||
      [...session_credential].some(
        (character) =>
          character.charCodeAt(0) <= 32 || character.charCodeAt(0) > 126,
      )
    )
      throw new Error("Builderlab did not return a valid credential.");
    const account = await request("/v1/auth/me", session_credential);
    if (typeof account?.subject !== "string" || !account.subject.trim())
      throw new Error("Builderlab did not return a valid account.");
    signal.throwIfAborted();
    // Focus return is best effort and must not delay verified login.
    completion = bridge.complete(id).catch(() => {});
    return credentialFor(session_credential, account);
  } catch (error) {
    if (signal.aborted) throw new Error("Sign-in canceled.");
    // Native errors are strings. Never forward provider bodies or credentials.
    throw error instanceof Error
      ? error
      : new Error("Could not complete Builderlab sign-in. Try again.");
  } finally {
    signal.removeEventListener("abort", cancel);
    // Canceling before completion settles would retire its focus permission.
    if (completion) void completion.then(cancel);
    else if (id) await bridge.cancel(id);
  }
}

// biome-ignore lint/suspicious/noExplicitAny: Builderlab's `v1/auth/me` JSON.
function credentialFor(value: string, account: any): Credential {
  return Object.freeze({
    value,
    account: Object.freeze({
      subject: account.subject,
      email: typeof account.email === "string" ? account.email.trim() : "",
      canUseRemoteAgents: account.capabilities?.can_use_remote_agents === true,
      canUseBuilderlabDecisions:
        account.capabilities?.can_use_builderlab_decisions === true,
    }),
  });
}

/** The OS secure item that keeps the browser sign-in across restarts. */
export type SavedCredential = {
  load(): Promise<string | null>;
  save(value: string): Promise<void>;
  clear(): Promise<void>;
};
const saves = new Set<() => void>();
export const savedCredential: SavedCredential = {
  load: () => invoke("builderlab_session_load", { target: oauthTarget() }),
  save: async (value) => {
    await invoke("builderlab_session_save", { target: oauthTarget(), value });
    for (const listener of [...saves]) listener();
  },
  clear: () => invoke("builderlab_session_clear", { target: oauthTarget() }),
};
/** Calls `listener` after each save in this app, such as first run's
 * sign-in, so a running session can restore it. */
export function onCredentialSaved(listener: () => void) {
  saves.add(listener);
  return () => {
    saves.delete(listener);
  };
}

/**
 * The saved credential with its account from `GET v1/auth/me`, or undefined
 * when none is saved or Builderlab rejects it (HTTP 401 or 403), which
 * deletes it. Rejects, keeping it, when Builderlab cannot answer.
 */
export async function restoredCredential(
  host: Pick<Host, "request">,
  signal: AbortSignal,
  saved: SavedCredential = savedCredential,
): Promise<Credential | undefined> {
  const value = await saved.load();
  signal.throwIfAborted();
  if (!value) return undefined;
  const response = await host.request({
    url: `${oauthTarget()}/v1/auth/me`,
    method: "GET",
    headers: { Accept: "application/json", "X-BB-Session-Credential": value },
  });
  signal.throwIfAborted();
  if (response.status === 401 || response.status === 403) {
    await saved.clear();
    return undefined;
  }
  if (response.status < 200 || response.status >= 300)
    throw new Error("Could not restore your Builderlab sign-in. Try again.");
  let account: { subject?: unknown } | undefined;
  try {
    account = JSON.parse(response.body);
  } catch {}
  if (typeof account?.subject !== "string" || !account.subject.trim())
    throw new Error("Could not restore your Builderlab sign-in. Try again.");
  return credentialFor(value, account);
}
