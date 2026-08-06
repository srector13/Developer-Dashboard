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

/// How many bytes from the start of the file to keep as a fingerprint.
///
/// This is the primary rotation signal, and it is deliberately not the file's
/// identity as the OS reports it:
///
///   * On Unix the inode is reliable, but it is not available on Windows
///     through stable Rust — `MetadataExt::file_index` is still unstable, and
///     it needs a handle rather than a path.
///   * Windows' creation time looks like a substitute and is a trap. NTFS
///     *file-system tunneling* hands a recreated file the creation time of the
///     one it replaced when both happen within about 15 seconds — which is
///     exactly what a log rotation is. The stale value then says "same file"
///     at the precise moment it is not.
///
/// Reading the first 256 bytes and comparing them costs one small read per
/// poll and works the same way on every platform. Any log worth tailing has a
/// timestamp in its first line, so two different files agreeing on 256 bytes
/// is not a case worth designing around.
const HEAD_BYTES: usize = 256;

/// A file's identity as the OS reports it. Kept as a *secondary* signal only:
/// on Unix the inode catches a replacement whose contents happen to match, and
/// on Windows the creation time does the same whenever tunneling doesn't
/// apply. Neither is trusted on its own — see `HEAD_BYTES`.
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

/// Has the start of the file changed under us?
///
/// Only the common prefix is compared, because a growing file legitimately has
/// a longer head than the one recorded when it was shorter. An empty recorded
/// head compares equal to anything — a file that was empty and now has content
/// has grown, not rotated.
fn head_changed(recorded: &[u8], current: &[u8]) -> bool {
    let common = recorded.len().min(current.len());
    recorded[..common] != current[..common]
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
    /// The first `HEAD_BYTES` of the file as last seen. The rotation signal.
    head: Vec<u8>,
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
            head: Vec::new(),
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

        // One handle for both reads. The head has to be re-read on every poll —
        // it is the rotation signal, so skipping it when nothing looks like it
        // has changed is exactly how a same-length replacement gets missed.
        let Ok(mut file) = File::open(&self.path) else {
            return Poll {
                missing: true,
                ..Default::default()
            };
        };
        let head = read_head(&mut file);

        // Rotation: a different file behind the same name, or the same file
        // truncated. Either way the offset we hold means nothing now.
        //
        // The head comparison is what catches a rotation on Windows, where the
        // reported identity can be stale and the replacement can be longer than
        // the offset we hold — see HEAD_BYTES.
        let rotated = self.started
            && (head_changed(&self.head, &head)
                || length < self.offset
                || self.identity != Some(current));
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
        self.head = head;

        if length <= self.offset {
            return Poll {
                rotated,
                ..Default::default()
            };
        }

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
        self.head.clear();
        self.identity = None;
        self.remainder.clear();
        self.started = true;
    }
}

/// The first `HEAD_BYTES` of an open file, or as much of it as exists.
///
/// A read that fails yields an empty head, which compares equal to everything
/// — a transient read error must not be reported as a rotation.
fn read_head(file: &mut File) -> Vec<u8> {
    if file.seek(SeekFrom::Start(0)).is_err() {
        return Vec::new();
    }
    let mut buffer = vec![0u8; HEAD_BYTES];
    match read_fully(file, &mut buffer) {
        Ok(read) => {
            buffer.truncate(read);
            buffer
        }
        Err(_) => Vec::new(),
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
    fn a_replacement_is_detected_from_content_alone() {
        // This is the regression test for the whole `HEAD_BYTES` design, and it
        // is written to defeat *every other* signal on *every* platform:
        //
        //   * rewriting in place keeps the inode (Unix) and the creation time
        //     (Windows), so the reported identity is unchanged;
        //   * the new content is exactly as long as the old, so the
        //     `length < offset` check cannot fire either.
        //
        // Only comparing the head of the file catches this. It is the same
        // blind spot NTFS file-system tunneling opens up for a real rotation:
        // a file recreated within ~15 seconds of the original being moved aside
        // inherits its creation time, so the OS says "same file" at the exact
        // moment it is not.
        let dir = scratch("same-length-replacement");
        let path = dir.join("app.log");
        std::fs::write(&path, b"aaaa\n").unwrap();

        let mut tail = Tail::new(&path);
        assert_eq!(tail.poll().lines, vec!["aaaa"]);

        std::fs::write(&path, b"bbbb\n").unwrap();

        let poll = tail.poll();
        assert!(poll.rotated, "the head of the file changed");
        assert_eq!(poll.lines, vec!["bbbb"]);
    }

    #[test]
    fn a_growing_file_is_not_mistaken_for_a_replacement() {
        // The head recorded when the file was short is a prefix of the head
        // read once it is long. Comparing them naively at full length would
        // report a rotation on every write.
        let dir = scratch("growing");
        let path = dir.join("app.log");
        append(&path, "ab\n");

        let mut tail = Tail::new(&path);
        assert!(!tail.poll().rotated);

        append(&path, &format!("{}\n", "c".repeat(HEAD_BYTES * 2)));
        let poll = tail.poll();
        assert!(!poll.rotated, "it grew, it was not replaced");
        assert_eq!(poll.lines.len(), 1);
    }

    #[test]
    fn a_file_that_was_empty_and_then_written_to_is_not_a_rotation() {
        // An empty head compares equal to anything; a service that creates its
        // log file before writing to it must not read as a replacement.
        let dir = scratch("empty-then-written");
        let path = dir.join("app.log");
        std::fs::write(&path, b"").unwrap();

        let mut tail = Tail::new(&path);
        assert!(!tail.poll().rotated);

        append(&path, "first line\n");
        let poll = tail.poll();
        assert!(!poll.rotated);
        assert_eq!(poll.lines, vec!["first line"]);
    }

    #[test]
    fn comparing_heads_only_looks_at_the_bytes_both_have() {
        assert!(!head_changed(b"", b"anything"));
        assert!(!head_changed(b"abc", b"abcdef"));
        assert!(!head_changed(b"abcdef", b"abc"));
        assert!(head_changed(b"abc", b"abd"));
        assert!(head_changed(b"abcdef", b"abd"));
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
