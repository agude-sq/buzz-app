//! The saved Builderlab browser sign-in credential of a build whose
//! Builderlab plugin does not use NIP-FI, so that sign-in survives restarts.
//! It is one OS secure item of its own per profile and compiled Builderlab
//! deployment, never another item, and only that deployment's caller uses it.
use zeroize::Zeroizing;

#[cfg_attr(test, allow(dead_code))]
const SERVICE: &str = if cfg!(debug_assertions) {
    "xyz.block.buzz.desktop.builderlab-session.debug"
} else {
    "xyz.block.buzz.desktop.builderlab-session"
};
const LIMIT: usize = 4096;

/// The item's account: the profile and the deployment's API base, so a build
/// for another Builderlab never reads, sends or deletes this one's credential.
fn account_for(profile: &str, origin: &str, api_base_path: &str) -> String {
    format!("{profile} {origin}{api_base_path}")
}

#[cfg_attr(test, allow(dead_code))]
fn account() -> String {
    let profile = std::env::var("BUZZODZ_PROFILE").unwrap_or_else(|_| "default".into());
    account_for(
        &profile,
        buzzodz_plugins::BUILDERLAB_ORIGIN,
        buzzodz_plugins::BUILDERLAB_API_BASE_PATH,
    )
}

/// The caller's sign-in target (`oauthTarget`) must be this build's.
fn bound(target: &str, origin: &str, api_base_path: &str) -> Result<(), String> {
    if origin.is_empty() || target != format!("{origin}{}", api_base_path.trim_end_matches('/')) {
        return Err("This saved sign-in belongs to another Builderlab".into());
    }
    Ok(())
}

fn this_build(target: &str) -> Result<(), String> {
    bound(
        target,
        buzzodz_plugins::BUILDERLAB_ORIGIN,
        buzzodz_plugins::BUILDERLAB_API_BASE_PATH,
    )
}

#[cfg(all(
    any(target_os = "macos", target_os = "windows", target_os = "linux"),
    not(test)
))]
mod platform {
    use super::*;
    use buzz_credential_store::{self as credentials, Error};
    fn error(error: Error) -> String {
        match error {
            Error::Denied => "Secure storage access was denied",
            Error::Busy => "Another Buzz app is using secure storage",
            _ => "Secure storage is unavailable",
        }
        .into()
    }
    pub(super) fn read() -> Result<Option<Zeroizing<Vec<u8>>>, String> {
        match credentials::read(SERVICE, &account()) {
            Ok(value) => Ok(Some(value)),
            Err(Error::Absent) => Ok(None),
            Err(e) => Err(error(e)),
        }
    }
    pub(super) fn replace(value: &[u8]) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        return security_framework::os::macos::keychain::SecKeychain::default()
            .and_then(|keychain| keychain.set_generic_password(SERVICE, &account(), value))
            .map_err(|_| "Secure storage is unavailable".to_string());
        #[cfg(not(target_os = "macos"))]
        credentials::replace(SERVICE, &account(), value).map_err(error)
    }
    pub(super) fn delete() -> Result<(), String> {
        match credentials::delete(SERVICE, &account()) {
            Ok(()) | Err(Error::Absent) => Ok(()),
            Err(e) => Err(error(e)),
        }
    }
}

// Native tests and other platforms never touch an OS credential store.
#[cfg(any(
    not(any(target_os = "macos", target_os = "windows", target_os = "linux")),
    test
))]
mod platform {
    use super::*;
    const NONE: &str = "Secure storage is not available here";
    pub(super) fn read() -> Result<Option<Zeroizing<Vec<u8>>>, String> {
        Err(NONE.into())
    }
    pub(super) fn replace(_: &[u8]) -> Result<(), String> {
        Err(NONE.into())
    }
    pub(super) fn delete() -> Result<(), String> {
        Err(NONE.into())
    }
}

async fn blocking<T: Send + 'static>(
    run: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(run)
        .await
        .map_err(|_| "Secure storage is unavailable".to_string())?
}

/// The saved credential record, or `None` when there is none.
#[tauri::command]
pub(crate) async fn builderlab_session_load(target: String) -> Result<Option<String>, String> {
    this_build(&target)?;
    let value = blocking(platform::read).await?;
    value
        .map(|bytes| {
            String::from_utf8(bytes.to_vec()).map_err(|_| "The saved sign-in is damaged".into())
        })
        .transpose()
}

#[tauri::command]
pub(crate) async fn builderlab_session_save(target: String, value: String) -> Result<(), String> {
    this_build(&target)?;
    let value = Zeroizing::new(value);
    if value.is_empty() || value.len() > LIMIT {
        return Err("Invalid Builderlab sign-in".into());
    }
    blocking(move || platform::replace(value.as_bytes())).await
}

#[tauri::command]
pub(crate) async fn builderlab_session_clear(target: String) -> Result<(), String> {
    this_build(&target)?;
    blocking(platform::delete).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_builderlab_deployment_has_its_own_item_and_callers() {
        let public = account_for("default", "https://app.builderlab.xyz", "/api/goose/");
        assert_ne!(
            public,
            account_for("default", "https://builderlab.example", "/api/goose/")
        );
        assert_ne!(
            public,
            account_for("default", "https://app.builderlab.xyz", "/team/api/goose/")
        );
        assert_ne!(
            public,
            account_for("work", "https://app.builderlab.xyz", "/api/goose/")
        );
        let origin = "https://app.builderlab.xyz";
        assert!(bound(
            "https://app.builderlab.xyz/api/goose",
            origin,
            "/api/goose/"
        )
        .is_ok());
        for other in [
            "https://builderlab.example/api/goose",
            "https://app.builderlab.xyz/team/api/goose",
            "",
        ] {
            assert!(bound(other, origin, "/api/goose/").is_err(), "{other}");
        }
        assert!(bound("/api/goose", "", "").is_err());
    }
}
