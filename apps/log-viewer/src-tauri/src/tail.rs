//! Reading the new bytes at the end of a file, over and over, without
//! re-reading the ones already seen.
//!
//! Three things make this harder than "read to end on a timer":
//!
//!   * **Rotation.** `app.log` becomes `app.log.1` and a new `app.log` appears.
//!     A reader still holding an offset of 4GB into a file that is now 200
//!     bytes long shows nothing, forever, and looks like the app has hung.
//!   * **Partial lines.** A poll lands between the writer emitting `ERROR: co`
//!     and `nnection refused\n`. Emitting the fragment as a line puts a
//!     permanent lie in the buffer, so the remainder is held until its newline
//!     arrives.
//!   * **Encoding.** A log can contain any bytes at all. Anything that fails to
//!     decode becomes U+FFFD rather than an error — a mangled character on one
//!     line is a nuisance, a reader that stops is an outage.

use std::fs::{File, Metadata};
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;

/// The most a single poll will read.
///
/// Pointing the viewer at a file that grows by 500MB between polls should show
/// the newest lines promptly, not block for a second building one enormous
/// batch. The remainder is picked up on the next poll, which is immediate.
const MAX_READ_PER_POLL: u64 = 8 * 1024 * 1024;

/// How much of a file to show when a source is first opened.
///
/// Opening a 2GB log and reading all of it is both slow and useless: the
/// interesting part of a log is the end. This is the "tail -n" of the app.
const INITIAL_TAIL_BYTES: u64 = 2 * 1024 * 1024;

/// A file's identity, used to notice that the name now points at a different
/// file.
///
/// On Unix this is the inode. On Windows it is the creation time, which is
/// *nearly* right: NTFS file-system tunneling can hand a recreated file the
/// creation time of the one it replaced, when both happen within about 15
/// seconds. That is why length is checked too — a rotated file is almost
/// always shorter than the offset we hold, and that check needs no OS support
/// at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Identity(u64);

#[cfg(unix)]
fn identity(metadata: &Metadata) -> Identity {
    use std::os::unix::fs::MetadataExt;
    Identity(metadata.ino())
}

#[cfg(windows)]
fn identity(metadata: &Metadata) -> Identity {
    use std::os::windows::fs::MetadataExt;
    Identity(metadata.creation_time())
}

#[cfg(not(any(unix, windows)))]
fn identity(_metadata: &Metadata) -> Identity {
    Identity(0)
}

/// What one poll produced.
#[derive(Debug, Default, PartialEq)]
pub struct Poll {
    pub lines: Vec<String>,
    /// The file was replaced or truncated since the last poll. The caller marks
    /// the boundary in the view, because "the file you were reading is gone" is
    /// something you want to see rather than infer from a gap.
    pub rotated: bool,
    /// The file could not be read this time — deleted, locked, not yet created.
    /// Not an error to report loudly: a log that does not exist yet is the
    /// normal state of a service that has not started.
    pub missing: bool,
}

/// An incremental reader over one file.
#[derive(Debug)]
pub struct Tail {
    path: PathBuf,
    offset: u64,
    identity: Option<Identity>,
    /// Bytes after the last newline seen, held until the line is complete.
    remainder: String,
    /// False until the first successful poll, which starts near the end of the
    /// file rather than at byte zero.
    started: bool,
}

impl Tail {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            offset: 0,
            identity: None,
            remainder: String::new(),
            started: false,
        }
    }

    /// Read whatever has been appended since the last call.
    ///
    /// Never returns an error: every failure mode here — the file is missing,
    /// locked by the writer, on a disconnected share — is a transient state
    /// that the next poll may well resolve, and none of them should interrupt
    /// the other sources.
    pub fn poll(&mut self) -> Poll {
        let Ok(metadata) = std::fs::metadata(&self.path) else {
            return Poll {
                missing: true,
                ..Default::default()
            };
        };
        if !metadata.is_file() {
            return Poll {
                missing: true,
                ..Default::default()
            };
        }

        let length = metadata.len();
        let current = identity(&metadata);

        // Rotation: a different file behind the same name, or the same file
        // truncated. Either way the offset we hold means nothing now.
        let rotated = self.started && (self.identity != Some(current) || length < self.offset);
        if rotated {
            self.offset = 0;
            self.remainder.clear();
        }

        // First sight of the file: start near the end, not at the beginning.
        if !self.started {
            self.offset = length.saturating_sub(INITIAL_TAIL_BYTES);
            self.started = true;
        }
        self.identity = Some(current);

        if length <= self.offset {
            return Poll {
                rotated,
                ..Default::default()
            };
        }

        let Ok(mut file) = File::open(&self.path) else {
            return Poll {
                rotated,
                missing: true,
                ..Default::default()
            };
        };
        if file.seek(SeekFrom::Start(self.offset)).is_err() {
            return Poll {
                rotated,
                missing: true,
                ..Default::default()
            };
        }

        let wanted = (length - self.offset).min(MAX_READ_PER_POLL);
        let mut buffer = vec![0u8; wanted as usize];
        let read = match read_fully(&mut file, &mut buffer) {
            Ok(read) => read,
            Err(_) => {
                return Poll {
                    rotated,
                    missing: true,
                    ..Default::default()
                }
            }
        };
        buffer.truncate(read);
        self.offset += read as u64;

        // A mid-poll seek into the middle of the file — the initial tail — can
        // land inside a line. Dropping that first partial line is the honest
        // thing to do; showing half a line as if it were whole is not.
        let text = String::from_utf8_lossy(&buffer);
        let mut chunk = std::mem::take(&mut self.remainder);
        chunk.push_str(&text);

        let lines = self.split(chunk);
        Poll {
            lines,
            rotated,
            missing: false,
        }
    }

    /// Split a chunk into complete lines, keeping any trailing fragment for the
    /// next poll.
    fn split(&mut self, chunk: String) -> Vec<String> {
        let mut lines = Vec::new();
        let mut rest = chunk.as_str();

        while let Some(newline) = rest.find('\n') {
            let (line, after) = rest.split_at(newline);
            lines.push(line.strip_suffix('\r').unwrap_or(line).to_string());
            rest = &after[1..];
        }
        self.remainder = rest.to_string();
        lines
    }

    /// Discard everything read so far and start again from the top of the file.
    /// Used by the renderer's "reload" — the one case where re-reading a
    /// 2GB file from byte zero is what was actually asked for.
    pub fn rewind(&mut self) {
        self.offset = 0;
        self.identity = None;
        self.remainder.clear();
        self.started = true;
    }
}

/// `Read::read` is permitted to return fewer bytes than asked for; loop until
/// the buffer is full or the file ends.
fn read_fully(file: &mut File, buffer: &mut [u8]) -> std::io::Result<usize> {
    let mut filled = 0;
    while filled < buffer.len() {
        match file.read(&mut buffer[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        }
    }
    Ok(filled)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::path::Path;

    /// A scratch directory unique to the calling test, so the suite can run in
    /// parallel without two tests writing the same file.
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("log-viewer-tail-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn append(path: &Path, text: &str) {
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .unwrap();
        file.write_all(text.as_bytes()).unwrap();
        file.flush().unwrap();
    }

    #[test]
    fn a_file_that_does_not_exist_yet_is_missing_rather_than_an_error() {
        let mut tail = Tail::new(scratch("absent").join("app.log"));
        let poll = tail.poll();
        assert!(poll.missing);
        assert!(poll.lines.is_empty());
    }

    #[test]
    fn a_missing_file_that_appears_later_starts_being_read() {
        let dir = scratch("appears");
        let path = dir.join("app.log");
        let mut tail = Tail::new(&path);
        assert!(tail.poll().missing);

        append(&path, "first\n");
        let poll = tail.poll();
        assert!(!poll.missing);
        assert_eq!(poll.lines, vec!["first"]);
    }

    #[test]
    fn only_new_bytes_are_returned_on_each_poll() {
        let dir = scratch("incremental");
        let path = dir.join("app.log");
        append(&path, "one\ntwo\n");

        let mut tail = Tail::new(&path);
        assert_eq!(tail.poll().lines, vec!["one", "two"]);
        // Nothing appended: nothing returned, rather than the same two lines.
        assert_eq!(tail.poll().lines, Vec::<String>::new());

        append(&path, "three\n");
        assert_eq!(tail.poll().lines, vec!["three"]);
    }

    #[test]
    fn a_partial_line_is_held_until_its_newline_arrives() {
        let dir = scratch("partial");
        let path = dir.join("app.log");
        append(&path, "ERROR: co");

        let mut tail = Tail::new(&path);
        // The fragment must not be emitted as if it were a whole line.
        assert_eq!(tail.poll().lines, Vec::<String>::new());

        append(&path, "nnection refused\n");
        assert_eq!(tail.poll().lines, vec!["ERROR: connection refused"]);
    }

    #[test]
    fn windows_line_endings_are_stripped() {
        let dir = scratch("crlf");
        let path = dir.join("app.log");
        append(&path, "one\r\ntwo\r\n");

        let mut tail = Tail::new(&path);
        assert_eq!(tail.poll().lines, vec!["one", "two"]);
    }

    #[test]
    fn truncation_in_place_is_detected_and_reading_restarts() {
        let dir = scratch("truncate");
        let path = dir.join("app.log");
        append(&path, "old line one\nold line two\n");

        let mut tail = Tail::new(&path);
        assert_eq!(tail.poll().lines.len(), 2);

        // `> app.log` in a shell: same file, length back to zero.
        std::fs::write(&path, "fresh\n").unwrap();
        let poll = tail.poll();
        assert!(poll.rotated, "a shorter file than our offset is a rotation");
        assert_eq!(poll.lines, vec!["fresh"]);
    }

    #[test]
    fn replacing_the_file_is_detected_even_when_the_new_one_is_longer() {
        let dir = scratch("replace");
        let path = dir.join("app.log");
        append(&path, "short\n");

        let mut tail = Tail::new(&path);
        assert_eq!(tail.poll().lines, vec!["short"]);

        // Rotation proper: the old file moves aside, a new one takes the name.
        std::fs::rename(&path, dir.join("app.log.1")).unwrap();
        append(
            &path,
            "a much longer first line in the new file\nand another\n",
        );

        let poll = tail.poll();
        assert!(poll.rotated, "a different file behind the same name");
        assert_eq!(poll.lines.len(), 2);
    }

    #[test]
    fn a_rotation_does_not_replay_the_lines_already_shown() {
        let dir = scratch("no-replay");
        let path = dir.join("app.log");
        append(&path, "before\n");

        let mut tail = Tail::new(&path);
        assert_eq!(tail.poll().lines, vec!["before"]);

        std::fs::write(&path, "after\n").unwrap();
        let poll = tail.poll();
        assert_eq!(poll.lines, vec!["after"], "only the new file's contents");
    }

    #[test]
    fn a_large_existing_file_is_opened_near_its_end() {
        let dir = scratch("initial-tail");
        let path = dir.join("big.log");
        // Comfortably past INITIAL_TAIL_BYTES, so the opening read is a tail.
        let filler = "x".repeat(1024);
        let mut file = std::fs::File::create(&path).unwrap();
        for _ in 0..(INITIAL_TAIL_BYTES / 1024 + 512) {
            writeln!(file, "{filler}").unwrap();
        }
        writeln!(file, "THE LAST LINE").unwrap();
        file.flush().unwrap();

        let mut tail = Tail::new(&path);
        let poll = tail.poll();
        assert_eq!(poll.lines.last().map(String::as_str), Some("THE LAST LINE"));
        // Not the whole file: that is the point of starting near the end.
        assert!(
            (poll.lines.len() as u64) < INITIAL_TAIL_BYTES / 1024,
            "opened {} lines, which is more than a tail",
            poll.lines.len()
        );
    }

    #[test]
    fn invalid_utf8_becomes_a_replacement_character_rather_than_stopping_the_read() {
        let dir = scratch("invalid-utf8");
        let path = dir.join("app.log");
        std::fs::write(&path, b"good\n\xff\xfe bad\ngood again\n").unwrap();

        let mut tail = Tail::new(&path);
        let poll = tail.poll();
        assert_eq!(poll.lines.len(), 3);
        assert_eq!(poll.lines[0], "good");
        assert!(poll.lines[1].contains('\u{fffd}'));
        assert_eq!(poll.lines[2], "good again");
    }

    #[test]
    fn a_final_line_with_no_trailing_newline_appears_once_it_is_terminated() {
        let dir = scratch("no-trailing-newline");
        let path = dir.join("app.log");
        append(&path, "complete\nincomplete");

        let mut tail = Tail::new(&path);
        assert_eq!(tail.poll().lines, vec!["complete"]);

        append(&path, "\n");
        assert_eq!(tail.poll().lines, vec!["incomplete"]);
    }

    #[test]
    fn rewinding_re_reads_the_file_from_the_beginning() {
        let dir = scratch("rewind");
        let path = dir.join("app.log");
        append(&path, "one\ntwo\n");

        let mut tail = Tail::new(&path);
        assert_eq!(tail.poll().lines.len(), 2);
        assert!(tail.poll().lines.is_empty());

        tail.rewind();
        assert_eq!(tail.poll().lines, vec!["one", "two"]);
    }
}
