import type { BuilderlabViewerSession } from "../../features/browser/api";
import type { FederatedIdentity } from "../../features/federated-identity/service";
import type { HostResponse } from "../../features/host/service";

export type Account = Readonly<{
  subject: string;
  email: string;
  canUseRemoteAgents: boolean;
  canUseBuilderlabDecisions: boolean;
}>;
/** One sign-in. A new sign-in is a new object, so identity tells a change. */
export type Credential = Readonly<{ account: Account }>;
export type LoginSnapshot = Readonly<{
  status: "signed-out" | "pending" | "signed-in";
  account?: Account;
  error?: string;
  /** Pending with no browser step, such as restoring a saved sign-in or
   * reading its account; it cannot be cancelled. */
  checking?: boolean;
  /** Signed in through the native NIP-FI session, whose sign-out is managed
   * in Identity; in an FI build that is every sign-in. */
  federated?: boolean;
}>;
/** A call under the Builderlab API root; `path` starts with `/`. */
export type BuilderlabRequest = Readonly<{
  path: string;
  method?: "GET" | "POST";
  headers?: Readonly<Record<string, string>>;
  body?: string;
}>;

/**
 * Builderlab's sign-in: the legacy in-memory OAuth credential, or in an FI
 * build the native NIP-FI session, whose token stays in OS secure storage
 * and survives restarts. Neither hands its token to consumers.
 */
export type BuilderlabSession = Readonly<{
  snapshot(): LoginSnapshot;
  subscribe(listener: () => void): () => void;
  credential(): Credential;
  /** Sends `input` as `credential`'s account. */
  request(
    credential: Credential,
    input: BuilderlabRequest,
  ): Promise<HostResponse>;
  /** Builderlab answered a call by `credential` with HTTP 401. */
  expired(credential: Credential): void;
  viewerSession(): BuilderlabViewerSession;
  /** Creation joins a login that is already running; it never cancels it. */
  ensureSignedIn(signal: AbortSignal): Promise<void>;
  signIn(): Promise<void>;
  cancel(): void;
  /** A view closing while a login is pending; only a login it owns ends. */
  abandon(): void;
  signOut(): void;
  dispose(): void;
}>;

/** One website store per account, so an app's own browser login outlives
 * sign-ins without crossing accounts. */
export async function accountStorage(subject: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(subject),
  );
  const hex = [...new Uint8Array(digest, 0, 16)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `builderlab-${hex}`;
}

/** Whether this build signs in to Builderlab with the native NIP-FI session. */
export const nativeBuilderlab = () =>
  import.meta.env.VITE_BUZZ_FEDERATED_IDENTITY === "1";
/** Whether this build's Builderlab is the built-in sign-in server, whose
 * sign-in is NIP-FI where it offers it and the browser's otherwise. */
export const autoBuilderlab = () =>
  import.meta.env.VITE_BUZZ_FEDERATED_IDENTITY === "auto";

/**
 * Which sign-in a server offers, from an uncredentialed `GET v1/session` at
 * its adapter: 404 has no NIP-FI sign-in, so `"browser"`; any other answer
 * is `"federated"`. Rejects on a network error or 5xx, which never falls
 * back to the browser.
 */
export async function offeredSignIn(
  probe: () => Promise<HostResponse>,
): Promise<"browser" | "federated"> {
  let status: number;
  try {
    status = (await probe()).status;
  } catch {
    status = 0;
  }
  if (status === 404) return "browser";
  if (status < 100 || status >= 500)
    throw new Error("Could not reach Builderlab. Try again.");
  return "federated";
}

/**
 * The built-in server's Builderlab session: its native NIP-FI session
 * whenever one exists or is starting, such as after a community that
 * requires NIP-FI asked for sign-in, and otherwise the browser sign-in. A
 * sign-in asks `offered` which one the server has, and Cancel ends that
 * question too. Once a NIP-FI session is signed in, the browser sign-in is
 * signed out, revoked and deleted, so it never comes back.
 */
export function createAutoSession(
  native: BuilderlabSession,
  browser: BuilderlabSession,
  offered: () => Promise<"browser" | "federated">,
  identity: Pick<FederatedIdentity, "snapshot" | "subscribe">,
): BuilderlabSession {
  let chosen: BuilderlabSession | undefined;
  let error: string | undefined;
  let probe: { promise?: Promise<BuilderlabSession | undefined> } | undefined;
  let state: LoginSnapshot = { status: "signed-out" };
  const listeners = new Set<() => void>();
  const owned = () =>
    [
      "signed-in",
      "signing-in",
      "restoring",
      "reauthentication-required",
    ].includes(identity.snapshot().status);
  const active = () => (owned() || chosen === native ? native : browser);
  const project = () => {
    if (
      identity.snapshot().status === "signed-in" &&
      browser.snapshot().status !== "signed-out"
    )
      browser.signOut();
    const current = active();
    const inner = current.snapshot();
    const next: LoginSnapshot = probe
      ? { status: "pending" }
      : error && inner.status === "signed-out"
        ? { status: "signed-out", error }
        : current === native
          ? { ...inner, federated: true }
          : inner;
    if (
      next.status !== state.status ||
      next.account !== state.account ||
      next.error !== state.error ||
      next.checking !== state.checking ||
      next.federated !== state.federated
    ) {
      state = Object.freeze(next);
      for (const listener of [...listeners]) listener();
    }
  };
  const stops = [
    native.subscribe(project),
    browser.subscribe(project),
    identity.subscribe(project),
  ];
  project();
  /** The sign-in the server offers; joined callers share one question, and
   * a canceled one answers undefined. */
  const choose = () => {
    if (probe?.promise) return probe.promise;
    const current: NonNullable<typeof probe> = {};
    probe = current;
    error = undefined;
    project();
    current.promise = offered()
      .then(
        (offer) => {
          if (probe !== current) return undefined;
          chosen = offer === "browser" ? browser : native;
          return chosen;
        },
        (failure) => {
          if (probe !== current) return undefined;
          error =
            failure instanceof Error
              ? failure.message
              : "Sign-in failed. Try again.";
          throw failure;
        },
      )
      .finally(() => {
        if (probe !== current) return;
        probe = undefined;
        project();
      });
    return current.promise;
  };
  const stop = () => {
    if (!probe) return false;
    probe = undefined;
    project();
    return true;
  };
  const signedIn = () => state.status === "signed-in";
  return {
    snapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    credential: () => active().credential(),
    request: (credential, input) => active().request(credential, input),
    expired: (credential) => active().expired(credential),
    viewerSession: () => active().viewerSession(),
    async ensureSignedIn(signal) {
      signal.throwIfAborted();
      if (signedIn()) return;
      if ((state.status === "pending" && !probe) || owned())
        return active().ensureSignedIn(signal);
      const session = await choose();
      signal.throwIfAborted();
      if (!session) throw new Error("Sign-in canceled.");
      return session.ensureSignedIn(signal);
    },
    async signIn() {
      if (signedIn() || probe) return;
      if (owned()) return native.signIn();
      const session = await choose().catch(() => undefined);
      await session?.signIn();
    },
    cancel: () => void (stop() || active().cancel()),
    abandon: () => void (stop() || active().abandon()),
    signOut: () => void (stop() || active().signOut()),
    dispose() {
      probe = undefined;
      for (const stop of stops) stop();
      listeners.clear();
      native.dispose();
      browser.dispose();
    },
  };
}

/**
 * The current NIP-FI session's account from Builderlab's `GET v1/auth/me`,
 * through the native forwarder, or undefined for any answer that is not one.
 * Rejects when the call or its JSON fails.
 */
export async function federatedAccount(
  identity: Pick<FederatedIdentity, "snapshot" | "request">,
): Promise<Account | undefined> {
  const authority = identity.snapshot().authority;
  if (!authority) return undefined;
  const response = await identity.request({
    path: `${authority.apiBasePath}v1/auth/me`,
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (response.status < 200 || response.status >= 300) return undefined;
  const value = JSON.parse(response.body) as {
    subject?: unknown;
    email?: unknown;
    capabilities?: {
      can_use_remote_agents?: unknown;
      can_use_builderlab_decisions?: unknown;
    };
  };
  if (typeof value?.subject !== "string" || !value.subject.trim())
    return undefined;
  return Object.freeze({
    subject: value.subject,
    email: typeof value.email === "string" ? value.email.trim() : "",
    canUseRemoteAgents: value.capabilities?.can_use_remote_agents === true,
    canUseBuilderlabDecisions:
      value.capabilities?.can_use_builderlab_decisions === true,
  });
}

const ACCOUNT_FAILED = "Could not load your Builderlab account. Try again.";

/**
 * The FI build's Builderlab session over the shared native NIP-FI session.
 * Each session revision reads its account from `GET v1/auth/me` once; until
 * then it is pending, and a failed read signs in again on retry. A 401 from
 * Builderlab refuses only that call: the native session decides when it ends.
 */
export function createNativeSession(
  identity: FederatedIdentity,
): BuilderlabSession {
  type Native = Credential & Readonly<{ revision: string; storage: string }>;
  let credential: Native | undefined;
  let viewer: BuilderlabViewerSession | undefined;
  let viewerLifetime: AbortController | undefined;
  let loading: string | undefined;
  let failed: string | undefined;
  let disposed = false;
  let state: LoginSnapshot = { status: "signed-out" };
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  const publish = (next: LoginSnapshot) => {
    if (
      next.status === state.status &&
      next.account === state.account &&
      next.error === state.error &&
      next.checking === state.checking
    )
      return;
    state = Object.freeze(next);
    notify();
  };
  const replace = (next: Native | undefined) => {
    if (next === credential) return;
    viewerLifetime?.abort();
    viewerLifetime = undefined;
    viewer = undefined;
    credential = next;
    if (!next) return;
    viewerLifetime = new AbortController();
    viewer = {
      federated: next.revision,
      storage: next.storage,
      signal: viewerLifetime.signal,
    };
  };
  async function load(revision: string) {
    loading = revision;
    let account: Account | undefined;
    let storage = "";
    try {
      account = await federatedAccount(identity);
      if (account) storage = await accountStorage(account.subject);
    } catch {
      // Fails closed below; signing in again retries.
    }
    if (disposed || loading !== revision) return;
    loading = undefined;
    const current = identity.snapshot();
    if (current.status !== "signed-in" || current.revision !== revision)
      return project();
    if (account) replace(Object.freeze({ revision, account, storage }));
    else failed = revision;
    project();
  }
  function project() {
    if (disposed) return;
    const current = identity.snapshot();
    if (current.status !== "signed-in") {
      replace(undefined);
      loading = failed = undefined;
      return publish(
        current.status === "signing-in"
          ? { status: "pending" }
          : current.status === "restoring"
            ? { status: "pending", checking: true }
            : current.status === "reauthentication-required"
              ? {
                  status: "signed-out",
                  error: "Your Builderlab sign-in ended. Sign in again.",
                }
              : current.failure && current.status !== "unconfigured"
                ? {
                    status: "signed-out",
                    error: "Builderlab sign-in did not finish. Try again.",
                  }
                : { status: "signed-out" },
      );
    }
    if (credential?.revision === current.revision)
      return publish({ status: "signed-in", account: credential.account });
    replace(undefined);
    if (failed === current.revision)
      return publish({ status: "signed-out", error: ACCOUNT_FAILED });
    failed = undefined;
    if (loading !== current.revision) void load(current.revision);
    publish({ status: "pending", checking: true });
  }
  const stop = identity.subscribe(project);
  project();
  const session: BuilderlabSession = {
    snapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    credential() {
      if (disposed || !credential)
        throw new Error("Sign in to Builderlab first.");
      return credential;
    },
    async request(owner, input) {
      const authority = identity.snapshot().authority;
      if (disposed || owner !== credential || !authority)
        throw new DOMException("Builderlab session changed.", "AbortError");
      // The service fences the call to the revision it starts under.
      return identity.request({
        ...input,
        path: `${authority.apiBasePath}${input.path.slice(1)}`,
      });
    },
    expired: () => {},
    viewerSession() {
      if (disposed || !viewer) throw new Error("Sign in to Builderlab first.");
      return viewer;
    },
    async ensureSignedIn(signal) {
      signal.throwIfAborted();
      if (disposed) throw new Error("Builderlab session is closed.");
      if (credential) return;
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          listeners.delete(changed);
          signal.removeEventListener("abort", abort);
        };
        const abort = () => {
          cleanup();
          reject(signal.reason);
        };
        const changed = () => {
          if (!disposed && state.status === "pending") return;
          cleanup();
          if (credential && !disposed) resolve();
          else
            reject(
              new Error(
                disposed
                  ? "Builderlab session is closed."
                  : (state.error ?? "Sign-in canceled."),
              ),
            );
        };
        listeners.add(changed);
        signal.addEventListener("abort", abort, { once: true });
        // Native may answer with an unchanged snapshot, which publishes
        // nothing; the finished attempt settles this wait instead.
        if (state.status !== "pending") void session.signIn().finally(changed);
      });
    },
    async signIn() {
      if (disposed) return;
      const current = identity.snapshot();
      if (current.status === "signed-in") {
        // Signed in natively: retry the account read that failed.
        if (failed !== current.revision) return;
        failed = undefined;
        return project();
      }
      if (current.status === "signing-in" || current.status === "restoring")
        return;
      try {
        await identity.signIn();
      } catch (error) {
        if (disposed || identity.snapshot().status === "signed-in") return;
        // Always announce it: a joined sign-in waits for this answer.
        state = Object.freeze({
          status: "signed-out",
          error:
            error instanceof Error
              ? error.message
              : "Sign-in failed. Try again.",
        });
        notify();
      }
    },
    cancel: () => void identity.cancelSignIn().catch(() => {}),
    // The native login is shared with community sign-in; no view owns it.
    abandon: () => {},
    signOut: () => void identity.signOut().catch(() => {}),
    dispose() {
      if (disposed) return;
      disposed = true;
      stop();
      replace(undefined);
      state = Object.freeze({ status: "signed-out" });
      notify();
      listeners.clear();
    },
  };
  return session;
}
