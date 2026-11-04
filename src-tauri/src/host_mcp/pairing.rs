use super::{authorization::Authorization, *};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use tauri::Manager;

const SERVICE: &str = "xyz.block.buzz.desktop.external-app-pairing.v1";
const LIFETIME: u64 = 30 * 24 * 60 * 60;
static LOCK: Mutex<()> = Mutex::new(());
static REVISION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
pub(super) fn revision() -> u64 {
    REVISION.load(Ordering::SeqCst)
}

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct Approval {
    pub client: String,
    pub viewer: String,
    pub agent: String,
    pub community: String,
    pub scopes: Vec<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Grant {
    #[serde(skip)]
    account: PathBuf,
    pub id: String,
    secret: String,
    pub approval: Approval,
    pub expires_at: u64,
    counter: u64,
    state: String,
}

impl Grant {
    pub fn active(&self) -> Result<(), String> {
        self.check_current(load(&self.account)?.as_ref())
    }
    fn check_current(&self, current: Option<&Grant>) -> Result<(), String> {
        let current = current.ok_or("Buzz approval is revoked")?;
        if current.id != self.id
            || current.secret != self.secret
            || current.expires_at != self.expires_at
            || current.approval != self.approval
            || current.expires_at <= now()?
        {
            return Err("Buzz approval is revoked or expired".into());
        }
        Ok(())
    }
    fn reserve(&mut self, request: &Authorization) -> Result<(), String> {
        self.check(request)?;
        let counter = request
            .resume
            .as_ref()
            .ok_or("Missing pairing proof")?
            .counter;
        if counter == 0 || counter > 999_999_999_999_999 || counter <= self.counter {
            return Err("Pairing request is already used".into());
        }
        self.counter = counter;
        self.state = request.state.clone();
        Ok(())
    }
    pub fn public(&self) -> serde_json::Value {
        serde_json::json!({"id": self.id, "approval": self.approval, "expires_at": self.expires_at})
    }
    pub fn descriptor(&self) -> serde_json::Value {
        serde_json::json!({"id": self.id, "secret": self.secret, "approval": self.approval, "expires_at": self.expires_at, "counter": self.counter})
    }
    fn mac(&self, value: serde_json::Value) -> Result<Hmac<Sha256>, String> {
        let key = URL_SAFE_NO_PAD
            .decode(&self.secret)
            .map_err(|_| "Invalid saved pairing")?;
        let mut mac = Hmac::<Sha256>::new_from_slice(&key).map_err(|_| "Invalid saved pairing")?;
        mac.update(value.to_string().as_bytes());
        Ok(mac)
    }
    fn check(&self, request: &Authorization) -> Result<(), String> {
        let resume = request.resume.as_ref().ok_or("Missing pairing proof")?;
        let proof = URL_SAFE_NO_PAD
            .decode(&resume.proof)
            .map_err(|_| "Invalid pairing proof")?;
        if self.id != resume.id || self.expires_at <= now()? {
            return Err("Buzz approval is revoked or expired".into());
        }
        self.mac(serde_json::json!([
            "buzz-resume-request-v1",
            self.id,
            resume.counter,
            request.callback,
            request.state,
            request.code_challenge
        ]))?
        .verify_slice(&proof)
        .map_err(|_| "Invalid pairing proof".into())
    }
    pub fn response_proof(
        &self,
        request: &Authorization,
        code: &str,
        endpoint: &str,
    ) -> Result<String, String> {
        Ok(URL_SAFE_NO_PAD.encode(
            self.mac(serde_json::json!([
                "buzz-resume-response-v1",
                self.id,
                self.counter,
                request.state,
                code,
                endpoint
            ]))?
            .finalize()
            .into_bytes(),
        ))
    }
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Resume {
    pub id: String,
    pub counter: u64,
    pub proof: String,
}

fn now() -> Result<u64, String> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_secs())
        .map_err(|_| "Cannot read the pairing clock".into())
}

fn account<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|_| "Cannot resolve pairing storage".into())
}

fn account_id(path: &Path) -> String {
    format!("{:x}", Sha256::digest(path.as_os_str().as_encoded_bytes()))
}

fn lock(path: &Path) -> Result<std::fs::File, String> {
    std::fs::create_dir_all(path).map_err(|_| "Cannot open pairing storage")?;
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path.join(".external-app-pairing.lock"))
        .map_err(|_| "Cannot open pairing storage")?;
    fs2::FileExt::try_lock_exclusive(&file).map_err(|_| "Pairing storage is busy")?;
    Ok(file)
}

pub(crate) fn revoke(path: &Path) -> Result<(), String> {
    let _lock = LOCK.lock().map_err(|_| "Pairing storage is busy")?;
    let _file = lock(path)?;
    clear(path)
}

fn load(account: &Path) -> Result<Option<Grant>, String> {
    match buzz_credential_store::read(SERVICE, &account_id(account)) {
        Ok(bytes) => {
            let mut grant: Grant =
                serde_json::from_slice(&bytes).map_err(|_| "Invalid saved pairing")?;
            let opaque = |value: &str| {
                URL_SAFE_NO_PAD
                    .decode(value)
                    .is_ok_and(|bytes| bytes.len() == 32 && URL_SAFE_NO_PAD.encode(bytes) == value)
            };
            if bytes.len() > 8192
                || !opaque(&grant.id)
                || !opaque(&grant.secret)
                || grant.counter > 999_999_999_999_999
            {
                return Err("Invalid saved pairing".into());
            }
            grant.account = account.into();
            Ok(Some(grant))
        }
        Err(buzz_credential_store::Error::Absent) => Ok(None),
        Err(_) => Err("Cannot read the saved Buzz approval".into()),
    }
}
fn save(account: &Path, grant: &Grant) -> Result<(), String> {
    let bytes =
        zeroize::Zeroizing::new(serde_json::to_vec(grant).map_err(|_| "Cannot encode pairing")?);
    #[cfg(target_os = "macos")]
    return security_framework::os::macos::keychain::SecKeychain::default()
        .and_then(|keychain| keychain.set_generic_password(SERVICE, &account_id(account), &bytes))
        .map_err(|_| "Cannot save the Buzz approval".into());
    #[cfg(not(target_os = "macos"))]
    buzz_credential_store::replace(SERVICE, &account_id(account), &bytes)
        .map_err(|_| "Cannot save the Buzz approval".into())
}
fn clear(account: &Path) -> Result<(), String> {
    match buzz_credential_store::delete(SERVICE, &account_id(account)) {
        Ok(()) | Err(buzz_credential_store::Error::Absent) => Ok(()),
        Err(_) => Err("Cannot revoke the saved Buzz approval".into()),
    }
}

pub(super) fn authorize<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    request: &Authorization,
    expected_revision: u64,
) -> Result<Option<Grant>, String> {
    let _lock = LOCK.lock().map_err(|_| "Pairing storage is busy")?;
    if revision() != expected_revision {
        return Err("Buzz approval is cancelled".into());
    }
    let account = account(app)?;
    let _file = lock(&account)?;
    match (&request.approval, &request.resume) {
        (None, None) => Ok(None),
        (Some(approval), resume) => {
            if let Some(resume) = resume {
                let grant = load(&account)?.ok_or("Buzz approval is revoked")?;
                grant.check(request)?;
                if grant.approval != *approval
                    || grant.counter != resume.counter
                    || grant.state != request.state
                {
                    return Err("Buzz approval does not match this connection".into());
                }
                return Ok(Some(grant));
            }
            let pubkey = |value: &str| {
                value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
            };
            if approval.client.is_empty()
                || approval.client.len() > 80
                || !pubkey(&approval.viewer)
                || approval.agent.len() > 600
                || !approval.agent.get(..64).is_some_and(pubkey)
                || approval.scopes.is_empty()
                || approval.scopes.len() > 2
                || approval
                    .scopes
                    .iter()
                    .any(|scope| scope != "read" && scope != "post")
                || approval
                    .scopes
                    .iter()
                    .collect::<std::collections::HashSet<_>>()
                    .len()
                    != approval.scopes.len()
                || url::Url::parse(&approval.community).is_err()
            {
                return Err("Invalid Buzz approval".into());
            }
            let secret = || {
                let mut bytes = [0; 32];
                getrandom::fill(&mut bytes).map_err(|_| "Cannot create a pairing")?;
                Ok::<_, String>(URL_SAFE_NO_PAD.encode(bytes))
            };
            let grant = Grant {
                account: account.clone(),
                id: secret()?,
                secret: secret()?,
                approval: approval.clone(),
                expires_at: now()? + LIFETIME,
                counter: 0,
                state: String::new(),
            };
            save(&account, &grant)?;
            Ok(Some(grant))
        }
        _ => Err("Missing Buzz approval".into()),
    }
}

pub(super) async fn forward(shared: &Shared, event: McpEvent) -> Result<(), String> {
    let grant = shared
        .pairing
        .lock()
        .map_err(|_| "Pairing state unavailable")?
        .clone();
    let Some(grant) = grant else {
        return shared
            .events
            .send(event)
            .map_err(|_| "The page is unavailable".into());
    };
    let stop = shared.stop.clone();
    let events = shared.events.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _lock = LOCK.lock().map_err(|_| "Pairing storage is busy")?;
        if stop.is_cancelled() {
            return Err("MCP session is closed".into());
        }
        let _file = lock(&grant.account)?;
        grant.active()?;
        events
            .send(event)
            .map_err(|_| "The page is unavailable".into())
    })
    .await
    .map_err(|_| "Cannot check Buzz approval")?
}

#[tauri::command]
pub(crate) async fn plugin_host_mcp_pairing<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    manager: tauri::State<'_, PluginManager>,
    servers: tauri::State<'_, HostMcpServers>,
    id: String,
    revision: String,
    operation: String,
    request: Option<Authorization>,
) -> Result<Option<serde_json::Value>, String> {
    if id != "buzz.agents" {
        return Err("Only Agents can manage external approval".into());
    }
    let granted = with_manager(manager, move |manager| {
        Ok(manager.host_grants(&id, &revision)?.mcp)
    })
    .await?;
    if !granted {
        return Err("MCP servers are not declared".into());
    }
    let servers = servers.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _lock = LOCK.lock().map_err(|_| "Pairing storage is busy")?;
        let account = account(&app)?;
        let _file = lock(&account)?;
        if operation == "revoke" {
            REVISION.fetch_add(1, Ordering::SeqCst);
            clear(&account)?;
            for entry in servers.registry().entries.values() {
                if entry
                    .shared
                    .pairing
                    .lock()
                    .map_or(true, |pairing| pairing.is_some())
                {
                    entry.shared.stop.cancel();
                }
            }
            return Ok(None);
        }
        let Some(mut grant) = load(&account)? else {
            return Ok(None);
        };
        if grant.expires_at <= now()? {
            clear(&account)?;
            return Ok(None);
        }
        match operation.as_str() {
            "get" => {}
            "resume" => {
                let request = request.ok_or("Missing pairing request")?;
                super::authorization::callback(&request)?;
                grant.reserve(&request)?;
                save(&account, &grant)?;
            }
            _ => return Err("Unknown pairing operation".into()),
        }
        Ok(Some(grant.public()))
    })
    .await
    .map_err(|_| "Cannot check Buzz approval")?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grant() -> Grant {
        Grant {
            account: "test-only".into(),
            id: "CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk".into(),
            secret: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc".into(),
            approval: Approval {
                client: "Test client".into(),
                viewer: "a".repeat(64),
                agent: "b".repeat(64),
                community: "https://example.test".into(),
                scopes: vec!["read".into()],
            },
            expires_at: u64::MAX,
            counter: 0,
            state: String::new(),
        }
    }
    fn request() -> Authorization {
        Authorization {
            callback: "http://127.0.0.1:1234/buzz/authorize".into(),
            state: "A".repeat(43),
            code_challenge: format!("{}A", "B".repeat(42)),
            approval: None,
            resume: Some(Resume {
                id: grant().id,
                counter: 1,
                proof: "qH9judhRwAJ50VJGXgDjDqeicXa4Lo7qUERD1PNzOnM".into(),
            }),
        }
    }

    #[test]
    fn storage_lock_excludes_other_handles_and_releases_on_close() {
        let directory = tempfile::tempdir().unwrap();
        let first = lock(directory.path()).unwrap();
        assert!(lock(directory.path()).is_err());
        drop(first);
        assert!(lock(directory.path()).is_ok());
    }

    #[test]
    fn reconnect_reserves_a_counter_and_retains_it_across_restart() {
        let mut saved = grant();
        saved.reserve(&request()).unwrap();
        let bytes = serde_json::to_vec(&saved).unwrap();
        let mut restored: Grant = serde_json::from_slice(&bytes).unwrap();
        assert!(restored
            .reserve(&request())
            .unwrap_err()
            .contains("already used"));
        assert_eq!(restored.approval.scopes, ["read"]);
        let mut next = request();
        next.resume.as_mut().unwrap().counter = 3;
        let proof = saved
            .mac(serde_json::json!([
                "buzz-resume-request-v1",
                saved.id,
                3,
                next.callback,
                next.state,
                next.code_challenge
            ]))
            .unwrap()
            .finalize()
            .into_bytes();
        next.resume.as_mut().unwrap().proof = URL_SAFE_NO_PAD.encode(proof);
        restored.reserve(&next).unwrap();
        assert_eq!(restored.counter, 3);
    }

    #[test]
    fn reconnect_proof_binds_each_request_field() {
        for field in ["callback", "state", "challenge", "id", "counter", "proof"] {
            let mut request = request();
            match field {
                "callback" => request.callback = "http://127.0.0.1:1235/buzz/authorize".into(),
                "state" => request.state = "D".repeat(43),
                "challenge" => request.code_challenge = "E".repeat(43),
                "id" => request.resume.as_mut().unwrap().id = "F".repeat(43),
                "counter" => request.resume.as_mut().unwrap().counter = 2,
                _ => request.resume.as_mut().unwrap().proof = "G".repeat(43),
            }
            assert!(grant().reserve(&request).is_err(), "{field}");
        }
    }

    #[test]
    fn response_proof_binds_the_new_endpoint_and_code() {
        let mut grant = grant();
        grant.reserve(&request()).unwrap();
        assert_eq!(
            grant
                .response_proof(
                    &request(),
                    &format!("{}A", "C".repeat(42)),
                    "http://127.0.0.1:4321/authorize/exchange"
                )
                .unwrap(),
            "JWWtY80VOE03eKoROm4OnmnvvtLwrBnQtfwy7GN1PGI"
        );
        assert!(grant.public().get("secret").is_none());
    }

    #[test]
    fn revoked_expired_and_changed_approval_cannot_dispatch() {
        let saved = grant();
        assert!(saved.check_current(Some(&saved)).is_ok());
        assert!(saved.check_current(None).is_err());
        for field in [
            "id",
            "secret",
            "viewer",
            "agent",
            "community",
            "scopes",
            "expiry",
        ] {
            let mut current = saved.clone();
            match field {
                "id" => current.id = "new-grant".into(),
                "secret" => current.secret = "changed".into(),
                "viewer" => current.approval.viewer = "c".repeat(64),
                "agent" => current.approval.agent = "d".repeat(64),
                "community" => current.approval.community = "https://other.test".into(),
                "scopes" => current.approval.scopes.push("post".into()),
                _ => current.expires_at = 0,
            }
            assert!(saved.check_current(Some(&current)).is_err(), "{field}");
        }
    }
}
