//! Dev Hub's own helpers, plus the shared ones re-exported so call sites keep
//! reading `crate::util::…`.
//!
//! The generic half — clock, relative ages, `{path}` substitution, program
//! resolution — now lives in `suite-core`, because the Log Viewer needs exactly
//! the same things. What stays here is git, which no other app in the suite
//! has an opinion about.

pub use suite_core::util::*;

/// Turn a git remote into something a browser can open.
///
/// Handles the three spellings that actually turn up in a checkout:
/// `git@host:owner/repo.git`, `ssh://git@host/owner/repo.git` and a plain
/// https URL. Anything else comes back as `None` rather than a broken link.
pub fn remote_to_web_url(remote: &str) -> Option<String> {
    let remote = remote.trim().trim_end_matches('/');
    let stripped = remote.strip_suffix(".git").unwrap_or(remote);

    if let Some(rest) = stripped.strip_prefix("ssh://") {
        // ssh://git@github.com/owner/repo  → drop the user, swap the scheme
        let rest = rest.split_once('@').map(|(_, r)| r).unwrap_or(rest);
        // A port (ssh://git@host:7999/…) is not meaningful over https.
        let rest = match rest.split_once('/') {
            Some((host, path)) => format!("{}/{}", host.split(':').next().unwrap_or(host), path),
            None => rest.to_string(),
        };
        return Some(format!("https://{rest}"));
    }
    if stripped.starts_with("https://") || stripped.starts_with("http://") {
        return Some(stripped.to_string());
    }
    if let Some(rest) = stripped.strip_prefix("git@") {
        // git@github.com:owner/repo
        let (host, path) = rest.split_once(':')?;
        return Some(format!("https://{host}/{}", path.trim_start_matches('/')));
    }
    None
}

/// The browse-a-branch URL for the hosts worth special-casing. Unknown hosts
/// fall back to the repo root, which is still useful and never wrong.
pub fn branch_web_url(web_url: &str, branch: &str) -> String {
    let branch = branch.trim();
    if branch.is_empty() {
        return web_url.to_string();
    }
    if web_url.contains("github.com") || web_url.contains("gitlab") {
        format!("{web_url}/tree/{branch}")
    } else if web_url.contains("bitbucket") {
        format!("{web_url}/branch/{branch}")
    } else if web_url.contains("dev.azure.com") || web_url.contains("visualstudio.com") {
        format!("{web_url}?version=GB{branch}")
    } else {
        web_url.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scp_style_remotes_become_https_urls() {
        assert_eq!(
            remote_to_web_url("git@github.com:srector13/dev-hub.git").as_deref(),
            Some("https://github.com/srector13/dev-hub")
        );
    }

    #[test]
    fn ssh_urls_lose_the_user_and_the_port() {
        assert_eq!(
            remote_to_web_url("ssh://git@bitbucket.example.com:7999/team/service.git").as_deref(),
            Some("https://bitbucket.example.com/team/service")
        );
    }

    #[test]
    fn https_remotes_only_lose_the_dot_git_suffix() {
        assert_eq!(
            remote_to_web_url("https://gitlab.example.com/group/app.git").as_deref(),
            Some("https://gitlab.example.com/group/app")
        );
    }

    #[test]
    fn an_unrecognisable_remote_is_none_rather_than_a_broken_link() {
        assert_eq!(remote_to_web_url("/srv/git/bare.git"), None);
        assert_eq!(remote_to_web_url(""), None);
    }

    #[test]
    fn branch_urls_follow_the_host_convention_and_fall_back_safely() {
        assert_eq!(
            branch_web_url("https://github.com/o/r", "feature/x"),
            "https://github.com/o/r/tree/feature/x"
        );
        assert_eq!(
            branch_web_url("https://bitbucket.example.com/t/s", "main"),
            "https://bitbucket.example.com/t/s/branch/main"
        );
        // Unknown host: the repo root, never a fabricated path.
        assert_eq!(
            branch_web_url("https://git.internal/x/y", "main"),
            "https://git.internal/x/y"
        );
        assert_eq!(
            branch_web_url("https://github.com/o/r", ""),
            "https://github.com/o/r"
        );
    }
}
