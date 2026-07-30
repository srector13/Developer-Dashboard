//! Small shared helpers: clock, relative times, remote-URL normalisation and
//! the `{path}` / `{line}` substitution used by the user-configured openers.

use std::path::Path;

pub fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// "just now" / "4m" / "3h" / "2d". Used for last-commit age and, in the
/// renderer, last-refreshed times.
pub fn relative_age(secs: i64) -> String {
    let secs = secs.max(0);
    match secs {
        0..=59 => "just now".to_string(),
        60..=3599 => format!("{}m ago", secs / 60),
        3600..=86_399 => format!("{}h ago", secs / 3600),
        86_400..=2_591_999 => format!("{}d ago", secs / 86_400),
        _ => format!("{}mo ago", secs / 2_592_000),
    }
}

/// Substitute the placeholders the config's `openWith` entries use.
///
/// Only `{path}` and `{line}` are recognised; anything else is left alone, so a
/// literal brace in a command line survives.
pub fn expand_placeholders(arg: &str, path: &str, line: Option<usize>) -> String {
    let mut out = arg.replace("{path}", path);
    if let Some(line) = line {
        out = out.replace("{line}", &line.to_string());
    }
    out
}

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

/// A display name for a path: the last component, or the whole thing when
/// there isn't one (a bare drive root).
pub fn base_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

/// Path with forward slashes, for subtitles that need to be readable on both
/// platforms (the renderer never has to care which OS wrote them).
pub fn display_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_ages_read_the_way_a_person_would_say_them() {
        assert_eq!(relative_age(0), "just now");
        assert_eq!(relative_age(59), "just now");
        assert_eq!(relative_age(60), "1m ago");
        assert_eq!(relative_age(7200), "2h ago");
        assert_eq!(relative_age(86_400 * 3), "3d ago");
        assert_eq!(relative_age(2_592_000 * 2), "2mo ago");
    }

    #[test]
    fn negative_ages_from_a_skewed_clock_do_not_underflow() {
        assert_eq!(relative_age(-500), "just now");
    }

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

    #[test]
    fn placeholders_expand_only_where_they_are_defined() {
        assert_eq!(expand_placeholders("-g", "C:\\notes\\a.md", Some(12)), "-g");
        assert_eq!(
            expand_placeholders("{path}:{line}", "C:\\notes\\a.md", Some(12)),
            "C:\\notes\\a.md:12"
        );
        // No line available — the token is left alone rather than becoming "0".
        assert_eq!(
            expand_placeholders("{path}:{line}", "/a.md", None),
            "/a.md:{line}"
        );
    }
}
