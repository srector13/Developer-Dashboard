//! The command line.
//!
//! Small on purpose. The Log Viewer is opened three ways — from its own
//! window, from Dev Hub's Logs card, and by dropping a file on the exe — and
//! only the middle one needs an argument at all:
//!
//! ```text
//! Log-Viewer.exe C:\services\api\application.log
//! Log-Viewer.exe --file C:\a.log --file C:\b.log
//! Log-Viewer.exe --file C:\a.log --no-follow
//! ```
//!
//! A second launch does not start a second process: the single-instance plugin
//! hands the arguments to the running window, which adds the files to what it
//! is already showing. That is what makes "tail this" from Dev Hub feel like
//! one app rather than a process spawner.

/// What a command line asked for.
#[derive(Debug, Default, PartialEq)]
pub struct Args {
    /// Files to open, in the order given.
    pub files: Vec<String>,
    /// `--follow` / `--no-follow`. `None` leaves the saved setting alone.
    pub follow: Option<bool>,
}

/// Parse an argument list that still has the program name at the front.
pub fn parse<I, S>(argv: I) -> Args
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut args = Args::default();
    let mut iter = argv.into_iter().skip(1).peekable();

    while let Some(raw) = iter.next() {
        let arg = raw.as_ref();
        match arg {
            "--follow" => args.follow = Some(true),
            "--no-follow" => args.follow = Some(false),
            "--file" | "-f" => {
                // A `--file` with nothing after it is a typo, not a file named
                // "--no-follow"; refuse to consume the next flag as a path.
                if let Some(next) = iter.peek() {
                    if !next.as_ref().starts_with('-') {
                        args.files.push(next.as_ref().to_string());
                        iter.next();
                    }
                }
            }
            _ => {
                if let Some(path) = arg.strip_prefix("--file=") {
                    if !path.is_empty() {
                        args.files.push(path.to_string());
                    }
                } else if !arg.starts_with('-') && !arg.is_empty() {
                    // A bare path, which is what dropping a file on the exe
                    // and most shells produce.
                    args.files.push(arg.to_string());
                }
            }
        }
    }
    args
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parsed(args: &[&str]) -> Args {
        parse(std::iter::once("log-viewer.exe").chain(args.iter().copied()))
    }

    #[test]
    fn no_arguments_asks_for_nothing() {
        assert_eq!(parsed(&[]), Args::default());
    }

    #[test]
    fn a_bare_path_is_a_file_to_open() {
        assert_eq!(parsed(&["C:\\a.log"]).files, vec!["C:\\a.log"]);
    }

    #[test]
    fn the_flag_form_is_accepted_in_both_spellings() {
        assert_eq!(parsed(&["--file", "C:\\a.log"]).files, vec!["C:\\a.log"]);
        assert_eq!(parsed(&["--file=C:\\a.log"]).files, vec!["C:\\a.log"]);
        assert_eq!(parsed(&["-f", "C:\\a.log"]).files, vec!["C:\\a.log"]);
    }

    #[test]
    fn several_files_keep_the_order_they_were_given() {
        let args = parsed(&["--file", "a.log", "--file", "b.log", "c.log"]);
        assert_eq!(args.files, vec!["a.log", "b.log", "c.log"]);
    }

    #[test]
    fn follow_can_be_turned_on_or_off_or_left_alone() {
        assert_eq!(parsed(&[]).follow, None);
        assert_eq!(parsed(&["--follow"]).follow, Some(true));
        assert_eq!(parsed(&["--no-follow"]).follow, Some(false));
    }

    #[test]
    fn a_dangling_file_flag_does_not_swallow_the_next_option() {
        let args = parsed(&["--file", "--no-follow"]);
        assert!(args.files.is_empty(), "there was no path to take");
        assert_eq!(args.follow, Some(false), "and the option still applied");
    }

    #[test]
    fn an_unknown_option_is_ignored_rather_than_treated_as_a_path() {
        assert!(parsed(&["--colour=always"]).files.is_empty());
    }

    #[test]
    fn the_program_name_is_never_mistaken_for_a_file() {
        assert!(parse(["C:\\tools\\Log-Viewer.exe"]).files.is_empty());
    }

    #[test]
    fn a_path_with_spaces_arrives_as_one_argument() {
        // The shell has already done the quoting; this only has to not split it.
        let args = parsed(&["C:\\Program Files\\svc\\app.log"]);
        assert_eq!(args.files, vec!["C:\\Program Files\\svc\\app.log"]);
    }
}
