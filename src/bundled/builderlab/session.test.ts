import { expect, it, vi } from "vitest";
import { federatedFixture } from "../../features/federated-identity/testing";
import {
  type BuilderlabSession,
  type LoginSnapshot,
  createAutoSession,
  createNativeSession,
  offeredSignIn,
} from "./session";

const me = (subject: string) => ({
  status: 200,
  headers: {},
  body: JSON.stringify({
    subject,
    email: ` ${subject}@example.com `,
    capabilities: { can_use_remote_agents: true },
  }),
});

it("reads each native session's account once and fences requests and viewers to it", async () => {
  const h = federatedFixture();
  h.request.mockResolvedValueOnce(me("first"));
  const session = createNativeSession(h.service);
  expect(session.snapshot().status).toBe("signed-out");
  await session.signIn();
  await expect.poll(() => session.snapshot().status).toBe("signed-in");
  expect(session.snapshot().account).toEqual({
    subject: "first",
    email: "first@example.com",
    canUseRemoteAgents: true,
    canUseBuilderlabDecisions: false,
  });
  expect(h.request).toHaveBeenLastCalledWith({
    path: "/api/goose/v1/auth/me",
    method: "GET",
    headers: { Accept: "application/json" },
  });
  const first = session.credential();
  const viewer = session.viewerSession();
  expect(viewer).toMatchObject({ federated: "user:1" });
  expect(viewer.storage).toMatch(/^builderlab-[0-9a-f]{32}$/);
  h.request.mockResolvedValueOnce({ status: 200, headers: {}, body: "{}" });
  await session.request(first, { path: "/v1/buzz/communities/list" });
  expect(h.request).toHaveBeenLastCalledWith({
    path: "/api/goose/v1/buzz/communities/list",
  });
  // Builderlab's 401 does not end the native session.
  session.expired(first);
  expect(session.snapshot().status).toBe("signed-in");

  h.request.mockResolvedValueOnce(me("second"));
  h.publish({ revision: "user:2" });
  expect(viewer.signal.aborted).toBe(true);
  await expect.poll(() => session.snapshot().account?.subject).toBe("second");
  await expect(session.request(first, { path: "/v1/auth/me" })).rejects.toThrow(
    "session changed",
  );
  expect(session.viewerSession()).toMatchObject({ federated: "user:2" });
  session.signOut();
  await expect.poll(() => session.snapshot().status).toBe("signed-out");
  expect(() => session.credential()).toThrow("Sign in to Builderlab first.");
  expect(h.request).toHaveBeenCalledTimes(3);
  session.dispose();
});

it("fails closed when the account cannot be read and retries on sign-in", async () => {
  const h = federatedFixture();
  h.request.mockResolvedValueOnce({ status: 403, headers: {}, body: "{}" });
  h.publish({ status: "signed-in", revision: "user:1" });
  const session = createNativeSession(h.service);
  await expect
    .poll(() => session.snapshot())
    .toEqual({
      status: "signed-out",
      error: "Could not load your Builderlab account. Try again.",
    });
  h.request.mockResolvedValueOnce(me("user"));
  await session.signIn();
  await expect.poll(() => session.snapshot().status).toBe("signed-in");
  expect(h.service.signIn).not.toHaveBeenCalled();
  session.dispose();
});

it("joins the shared native sign-in and leaves it running when a view closes", async () => {
  const h = federatedFixture();
  h.publish({ status: "signing-in" });
  const session = createNativeSession(h.service);
  expect(session.snapshot().status).toBe("pending");
  const joined = session.ensureSignedIn(new AbortController().signal);
  session.abandon();
  expect(h.service.cancelSignIn).not.toHaveBeenCalled();
  h.request.mockResolvedValueOnce(me("user"));
  h.publish({ status: "signed-in", revision: "user:1" });
  await expect(joined).resolves.toBeUndefined();
  expect(h.service.signIn).not.toHaveBeenCalled();
  session.cancel();
  expect(h.service.cancelSignIn).toHaveBeenCalledOnce();
  session.dispose();
});

it("settles a sign-in wait when native sign-in leaves the session unchanged", async () => {
  const h = federatedFixture();
  h.publish({ status: "unavailable", failure: "native-unavailable" });
  // Native returns the same snapshot, as it does before restore finishes.
  vi.mocked(h.service.signIn).mockImplementationOnce(async () =>
    h.service.snapshot(),
  );
  const session = createNativeSession(h.service);
  await expect(
    session.ensureSignedIn(new AbortController().signal),
  ).rejects.toThrow("Builderlab sign-in did not finish. Try again.");
  expect(h.service.signIn).toHaveBeenCalledOnce();
  session.dispose();
});

it("shows a session the adapter ended as signed out, asking to sign in again", async () => {
  const h = federatedFixture();
  h.request.mockResolvedValueOnce(me("user"));
  h.publish({ status: "signed-in", revision: "user:1" });
  const session = createNativeSession(h.service);
  await expect.poll(() => session.snapshot().status).toBe("signed-in");
  h.publish({
    status: "reauthentication-required",
    revision: "user:2",
    failure: "reauthentication-required",
  });
  expect(session.snapshot()).toEqual({
    status: "signed-out",
    error: "Your Builderlab sign-in ended. Sign in again.",
  });
  session.dispose();
});

it.each([
  [404, "browser"],
  [401, "federated"],
  [200, "federated"],
] as const)(
  "a %i from v1/session offers the %s sign-in",
  async (status, offer) => {
    await expect(
      offeredSignIn(async () => ({ status, headers: {}, body: "" })),
    ).resolves.toBe(offer);
  },
);

it("never falls back to the browser on a network error or 5xx", async () => {
  await expect(
    offeredSignIn(async () => ({ status: 503, headers: {}, body: "" })),
  ).rejects.toThrow("Could not reach Builderlab");
  await expect(
    offeredSignIn(async () => {
      throw new Error("offline");
    }),
  ).rejects.toThrow("Could not reach Builderlab");
});

function fake(): BuilderlabSession & {
  set(next: LoginSnapshot): void;
  signIn: ReturnType<typeof vi.fn>;
} {
  let state: LoginSnapshot = { status: "signed-out" };
  const listeners = new Set<() => void>();
  const credential = { account: { subject: "x" } } as never;
  const session = {
    set(next: LoginSnapshot) {
      state = next;
      for (const listener of listeners) listener();
    },
    snapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    credential: () => credential,
    request: vi.fn(),
    expired: vi.fn(),
    viewerSession: vi.fn(),
    ensureSignedIn: vi.fn(async () => {}),
    signIn: vi.fn(async () => {}),
    cancel: vi.fn(),
    abandon: vi.fn(),
    signOut: vi.fn(),
    dispose: vi.fn(),
  };
  return session as never;
}
/** The native identity's status, which says whether a NIP-FI session exists. */
function owner(status = "signed-out") {
  const listeners = new Set<() => void>();
  return {
    snapshot: () => ({ status }) as never,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    set(next: string) {
      status = next;
      for (const listener of [...listeners]) listener();
    },
  };
}
const account = {
  subject: "user",
  email: "",
  canUseRemoteAgents: false,
  canUseBuilderlabDecisions: false,
};

it("signs in with the sign-in the server offers, and shows a probe failure", async () => {
  const native = fake();
  const browser = fake();
  const offered = vi
    .fn<() => Promise<"browser" | "federated">>()
    .mockResolvedValueOnce("browser")
    .mockResolvedValueOnce("federated")
    .mockRejectedValueOnce(new Error("Could not reach Builderlab. Try again."));
  const session = createAutoSession(native, browser, offered, owner());
  await session.signIn();
  expect(browser.signIn).toHaveBeenCalledTimes(1);
  expect(native.signIn).not.toHaveBeenCalled();
  await session.signIn();
  expect(native.signIn).toHaveBeenCalledTimes(1);
  await session.signIn();
  expect(session.snapshot()).toEqual({
    status: "signed-out",
    error: "Could not reach Builderlab. Try again.",
  });
  expect(browser.signIn).toHaveBeenCalledTimes(1);
  expect(native.signIn).toHaveBeenCalledTimes(1);
});

it("prefers an existing NIP-FI session, showing its account read, and retires the browser sign-in", async () => {
  const native = fake();
  const browser = fake();
  const identity = owner();
  const offered = vi.fn(async () => "browser" as const);
  const session = createAutoSession(native, browser, offered, identity);
  browser.set({ status: "signed-in", account });
  expect(session.snapshot()).toEqual({ status: "signed-in", account });
  session.signOut();
  expect(browser.signOut).toHaveBeenCalledTimes(1);
  // A community that requires NIP-FI signed the server in; its account read
  // fails, which shows with its retry instead of the older browser account.
  const failed = { status: "signed-out", error: "Could not load" } as const;
  native.set(failed);
  identity.set("signed-in");
  expect(session.snapshot()).toEqual({ ...failed, federated: true });
  // Taking over signs the browser sign-in out, which revokes and deletes it.
  expect(browser.signOut).toHaveBeenCalledTimes(2);
  await session.signIn();
  expect(native.signIn).toHaveBeenCalledTimes(1);
  expect(browser.signIn).not.toHaveBeenCalled();
  expect(offered).not.toHaveBeenCalled();
  session.signOut();
  expect(native.signOut).toHaveBeenCalledTimes(1);
});

it("lets Cancel or a closing view end the server check, so its sign-in never starts", async () => {
  for (const end of ["cancel", "abandon"] as const) {
    const native = fake();
    const browser = fake();
    let answer!: (offer: "browser") => void;
    const offered = vi.fn(
      () => new Promise<"browser">((resolve) => (answer = resolve)),
    );
    const session = createAutoSession(native, browser, offered, owner());
    const signingIn = session.signIn();
    const joined = session.ensureSignedIn(new AbortController().signal);
    expect(session.snapshot().status).toBe("pending");
    expect(offered).toHaveBeenCalledTimes(1);
    session[end]();
    expect(session.snapshot()).toEqual({ status: "signed-out" });
    answer("browser");
    await signingIn;
    await expect(joined).rejects.toThrow("Sign-in canceled.");
    expect(browser.signIn).not.toHaveBeenCalled();
    expect(browser.ensureSignedIn).not.toHaveBeenCalled();
    expect(browser[end]).not.toHaveBeenCalled();
  }
});
