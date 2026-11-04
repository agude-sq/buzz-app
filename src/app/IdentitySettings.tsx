import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { npubEncode } from "nostr-tools/nip19";
import type { BackupStatus } from "../features/identity/backup";
import { BACKUP_FAILURES } from "../features/identity/backup-failure";
import { backupOfferedFor } from "../features/identity/builderlab-account";
import type { Identity } from "../features/identity/service";
import {
  signInServers,
  type FederatedIdentity,
  type SessionSnapshot,
} from "../features/federated-identity/service";
import type { Membership } from "../features/communities/service";
import {
  coveredCommunities,
  serverName,
} from "../features/federated-identity/community-servers";
import { recoveryMessage } from "../features/federated-identity/CommunitySignIn";
import { PrivateKey } from "../features/identity/PrivateKey";
import { SignOutDialog } from "../features/identity/SignOut";
import { Header, InlineHeader } from "../shared/design-system/ui/Header";
import { SettingsGroup } from "../shared/design-system/ui/SettingsGroup";
import { PreferenceRow } from "../shared/design-system/ui/PreferenceRow";
import { IconButton } from "../shared/design-system/ui/IconButton";
import { Button } from "../shared/design-system/ui/Button";
import { Tooltip } from "../shared/design-system/ui/Tooltip";
import { ToastNotice } from "../shared/design-system/ui/Toast";
import { CopyIcon } from "../shared/design-system/icons";
import styles from "./IdentitySettings.module.css";
import { writeClipboardText } from "../shared/clipboard";

const WAITING = {
  no_consent: "Automatic backup is off for this key.",
  no_session: "Sign in to Builderlab to back up your key.",
  not_linked: BACKUP_FAILURES.not_linked.message,
} as const;

/** Unavailable for want of native, not because a sign-out didn't finish. */
const NOT_SIGN_OUT = new Set(["native-unavailable", "desktop-required"]);

/** One sentence per uploader status; failures read as first run's copy. */
function backupSentence(status: BackupStatus) {
  switch (status.status) {
    case "idle":
      // Nothing has run this launch; a backup may still exist from an earlier one.
      return "Buzz hasn’t checked your key’s backup since it opened.";
    case "running":
      return "Backing up your key…";
    case "complete":
      return "Your key is backed up to Builderlab.";
    case "waiting":
      return WAITING[status.reason];
    case "failed": {
      // Settings has no Try again; a new Builderlab sign-in hands the
      // uploader a session, which starts another pass, so a kind it clears
      // (every retryable one, and a lapsed sign-in) says so.
      const failure: { cause?: string; message: string } =
        BACKUP_FAILURES[status.kind];
      return failure.cause
        ? `${failure.cause} Buzz tries again when you next sign in to Builderlab.`
        : failure.message;
    }
  }
}

/**
 * Read-only until the consent wording is signed off. Hidden wherever first run
 * would not offer backup, by the same rule.
 */
function BackupRow({ backup }: { backup: Identity["backup"] }) {
  const status = useSyncExternalStore(backup.subscribe, backup.snapshot);
  const [offered, setOffered] = useState(false);
  useEffect(() => {
    void backupOfferedFor(backup).then(setOffered);
  }, [backup]);
  if (!offered || !status) return null;
  return (
    <PreferenceRow
      title="Key backup"
      subtitle={<span role="status">{backupSentence(status)}</span>}
    />
  );
}

export function IdentitySettings({
  viewer,
  identity,
  federatedIdentity,
  memberships = [],
  servers = signInServers,
}: {
  viewer?: string | undefined;
  identity?: Identity | undefined;
  federatedIdentity?: FederatedIdentity | undefined;
  /** Joined communities, for each server's "Used by". */
  memberships?: readonly Membership[] | undefined;
  /** The build's sign-in servers; native's compiled list by default. */
  servers?: () => Promise<readonly SessionSnapshot[]>;
}) {
  const [signingOut, setSigningOut] = useState(false);
  const [copyStatus, setCopyStatus] = useState<{
    message: string;
    failed: boolean;
  } | null>(null);
  const copyAttempt = useRef(0);
  const npub = viewer ? npubEncode(viewer) : "";
  async function copyIdentity(value: string, label: string) {
    const attempt = ++copyAttempt.current;
    setCopyStatus(null);
    try {
      await writeClipboardText(value);
      if (attempt === copyAttempt.current)
        setCopyStatus({ message: `${label} copied.`, failed: false });
    } catch {
      if (attempt === copyAttempt.current)
        setCopyStatus({
          message: `Couldn’t copy ${label.toLowerCase()}. Select it and copy manually.`,
          failed: true,
        });
    }
  }
  return (
    <section aria-labelledby="identity-settings-title">
      <Header
        id="identity-settings-title"
        title="Identity"
        subtitle="Your identity is shared across communities. Public keys are safe to share."
      />
      {!viewer && (
        <p>Your identity is unavailable. Connect your identity to manage it.</p>
      )}
      {viewer && (
        <>
          <SettingsGroup>
            {(
              [
                ["Public key (hex)", "Public key", viewer],
                ["Nostr address (npub)", "Nostr address", npub],
              ] as const
            ).map(([label, copyLabel, value]) => (
              <PreferenceRow
                key={label}
                title={label}
                subtitle={
                  <code className={`text-mono ${styles.identityValue}`}>
                    {value}
                  </code>
                }
                trailing={
                  <Tooltip
                    content={`Copy ${copyLabel.toLowerCase()}`}
                    hint="familiar"
                  >
                    <IconButton
                      size="sm"
                      variant="ghost"
                      aria-label={`Copy ${copyLabel.toLowerCase()}`}
                      icon={<CopyIcon aria-hidden="true" />}
                      onClick={() => void copyIdentity(value, copyLabel)}
                    />
                  </Tooltip>
                }
              />
            ))}
          </SettingsGroup>
          {identity && (
            <div className="mt-6">
              <SettingsGroup layout="form">
                {/* One key widget at a time; the dialog brings its own. */}
                {!signingOut && <PrivateKey identity={identity} />}
              </SettingsGroup>
              <SettingsGroup>
                <BackupRow backup={identity.backup} />
                <PreferenceRow
                  title="Sign out of Buzz"
                  subtitle="Remove your private key from this device. Also signs you out of your organization and ends Builderlab and hosted community logins."
                  trailing={
                    <Button type="button" onClick={() => setSigningOut(true)}>
                      Sign out of Buzz
                    </Button>
                  }
                />
              </SettingsGroup>
              {signingOut && (
                <SignOutDialog
                  identity={identity}
                  onClose={() => setSigningOut(false)}
                />
              )}
            </div>
          )}
          {federatedIdentity && (
            <OrganizationSignIns
              identity={federatedIdentity}
              memberships={memberships}
              servers={servers}
            />
          )}
          {copyStatus && (
            <ToastNotice
              title={
                copyStatus.failed
                  ? "Identity wasn’t copied"
                  : copyStatus.message
              }
              {...(copyStatus.failed
                ? { description: copyStatus.message }
                : {})}
              tone={copyStatus.failed ? "error" : "success"}
              timeout={copyStatus.failed ? 0 : 5000}
              onDismiss={() => setCopyStatus(null)}
            />
          )}
        </>
      )}
    </section>
  );
}

/** Every server's session, live: one stable array until one changes. */
function useSessions(sessions: readonly FederatedIdentity[]) {
  const store = useMemo(() => {
    let cached: readonly SessionSnapshot[] = [];
    return {
      subscribe: (listener: () => void) => {
        const stops = sessions.map((session) => session.subscribe(listener));
        return () => {
          for (const stop of stops) stop();
        };
      },
      snapshot: () => {
        const next = sessions.map((session) => session.snapshot());
        if (
          next.length !== cached.length ||
          next.some((state, index) => state !== cached[index])
        )
          cached = next;
        return cached;
      },
    };
  }, [sessions]);
  return useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
}

/** One row per signed-in server, each signing out of that server only. With
 * none signed in, the build's Builderlab row, to sign in from. */
function OrganizationSignIns({
  identity,
  memberships,
  servers,
}: {
  identity: FederatedIdentity;
  memberships: readonly Membership[];
  servers: () => Promise<readonly SessionSnapshot[]>;
}) {
  const [ids, setIds] = useState<readonly string[]>([]);
  useEffect(() => {
    let active = true;
    void servers()
      .then((list) => {
        if (active)
          setIds(list.flatMap((server) => server.authority?.id ?? []));
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [servers]);
  const sessions = useMemo(
    () => ids.flatMap((id) => identity.forServer?.(id) ?? []),
    [identity, ids],
  );
  const states = useSessions(sessions);
  // Kept here, not in a row: a sign-out that fails still leaves signed-in,
  // so its row goes, and the failure must outlive it.
  const [failures, setFailures] = useState<
    ReadonlyMap<FederatedIdentity, SignOutFailure>
  >(new Map());
  const report = (session: FederatedIdentity, failure?: SignOutFailure) =>
    setFailures((current) => {
      const next = new Map(current);
      if (failure) next.set(session, failure);
      else next.delete(session);
      return next;
    });
  const signOut = (session: FederatedIdentity) => {
    const authority = session.snapshot().authority;
    if (!authority) return;
    report(session);
    void session.signOut().catch((error: unknown) =>
      report(session, {
        authority,
        failure: error instanceof Error ? error.message : "",
      }),
    );
  };
  const signedIn = sessions.filter(
    (_, index) =>
      states[index]?.status === "signed-in" && states[index]?.authority,
  );
  // Native reports a sign-out it couldn't finish, such as a storage failure,
  // as that server's unavailable snapshot rather than an error. Read from the
  // session, it survives Settings closing and a reload until cleanup ends.
  const unfinished = new Map(failures);
  sessions.forEach((session, index) => {
    const state = states[index];
    if (
      state?.status === "unavailable" &&
      state.authority &&
      !NOT_SIGN_OUT.has(state.failure ?? "")
    )
      unfinished.set(session, {
        authority: state.authority,
        failure: state.failure ?? "",
      });
  });
  const problems = [...unfinished].map(([session, { authority, failure }]) => (
    <div key={authority.id}>
      <p role="alert" className="text-body-sm text-danger">
        {`Couldn’t sign out of ${serverName(authority)}. ${recoveryMessage(failure)}`}
      </p>
      <Button type="button" onClick={() => signOut(session)}>
        Try again
      </Button>
    </div>
  ));
  // The first server's own row would repeat its failure without naming it.
  const firstFailed = [...unfinished.values()].some(
    ({ authority }) => authority.id === identity.snapshot().authority?.id,
  );
  if (signedIn.length === 0)
    return (
      <>
        {!firstFailed && <OrganizationSignIn identity={identity} />}
        {problems}
      </>
    );
  return (
    <section className="mt-6" aria-labelledby="organization-sign-in-title">
      <InlineHeader
        id="organization-sign-in-title"
        title="Organization sign-in"
      />
      <SettingsGroup>
        {signedIn.map((session) => (
          <ServerSession
            key={session.snapshot().authority?.id}
            session={session}
            memberships={memberships}
            onSignOut={() => signOut(session)}
          />
        ))}
        {problems}
      </SettingsGroup>
    </section>
  );
}

type SignOutFailure = Readonly<{
  authority: NonNullable<SessionSnapshot["authority"]>;
  failure: string;
}>;

function ServerSession({
  session,
  memberships,
  onSignOut,
}: {
  session: FederatedIdentity;
  memberships: readonly Membership[];
  onSignOut: () => void;
}) {
  const state = useSyncExternalStore(
    session.subscribe,
    session.snapshot,
    session.snapshot,
  );
  if (!state.authority) return null;
  const host = new URL(state.authority.identityOrigin).host;
  const name = serverName(state.authority);
  const usedBy = coveredCommunities(
    state.authority.communityHosts,
    memberships,
  );
  const expires = state.expiresAt
    ? new Date(state.expiresAt).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "";
  return (
    <PreferenceRow
      title={name === host ? host : `${name} (${host})`}
      subtitle={
        <>
          {`Signed in as ${state.email ?? "your organization account"}`}
          {expires && ` · Expires at ${expires}`}
          {usedBy.length > 0 && (
            <>
              <br />
              {`Used by: ${usedBy.join(", ")}`}
            </>
          )}
        </>
      }
      trailing={
        <Button
          type="button"
          aria-label={`Sign out of ${host}`}
          onClick={onSignOut}
        >
          Sign out
        </Button>
      }
    />
  );
}

function OrganizationSignIn({ identity }: { identity: FederatedIdentity }) {
  const state = useSyncExternalStore(
    identity.subscribe,
    identity.snapshot,
    identity.snapshot,
  );
  const [failure, setFailure] = useState("");
  const problem = failure || state.failure;
  if (!state.authority || state.status === "unconfigured") return null;
  // Controls hide when unavailable, but a failed sign-out still explains itself.
  if (state.status === "unavailable")
    return problem ? (
      <p role="alert" className="mt-6 text-body-sm text-danger">
        {recoveryMessage(problem)}
      </p>
    ) : null;
  const organization = new URL(state.authority.identityOrigin).host;
  const signedIn = state.status === "signed-in";
  const signingIn = state.status === "signing-in";
  const expires =
    signedIn && state.expiresAt
      ? new Date(state.expiresAt).toLocaleString(undefined, {
          dateStyle: "medium",
          timeStyle: "short",
        })
      : "";
  function run(operation: () => Promise<unknown>) {
    setFailure("");
    void Promise.resolve()
      .then(operation)
      .catch((error: unknown) =>
        setFailure(
          error instanceof Error ? error.message : "Sign-in unavailable",
        ),
      );
  }
  return (
    <section className="mt-6" aria-labelledby="organization-sign-in-title">
      <InlineHeader
        id="organization-sign-in-title"
        title="Organization sign-in"
      />
      <SettingsGroup>
        <PreferenceRow
          title={
            signedIn
              ? `Signed in as ${state.email ?? "your organization account"}`
              : "Not signed in"
          }
          subtitle={
            <>
              {expires && (
                <>
                  Expires at {expires}
                  <br />
                </>
              )}
              {`Lets you and your agents into communities that require your ${organization} login. Signing out keeps your Buzz key on this device, but you and your agents can’t connect to those communities again until you sign back in.`}
            </>
          }
          trailing={
            <Button
              type="button"
              disabled={state.status === "restoring"}
              onClick={() =>
                run(() =>
                  signedIn
                    ? identity.signOut()
                    : signingIn
                      ? identity.cancelSignIn()
                      : identity.signIn(),
                )
              }
            >
              {signedIn
                ? "Sign out of organization"
                : signingIn
                  ? "Cancel sign-in"
                  : "Sign in"}
            </Button>
          }
        />
        {problem && (
          <p role="alert" className="text-body-sm text-danger">
            {recoveryMessage(problem)}
          </p>
        )}
      </SettingsGroup>
    </section>
  );
}
