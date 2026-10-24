//! TypeScript's `lib.*.d.ts` files: the ones built in, as `bun check` has them, or the set an embedder registered with
//! `bun_sema_set_libs`, which then replaces them for the whole process.
//!
//! The built-in part is a copy of Bun's `src/runtime/cli/typescript_libs.rs` (same tree, at 1917b1a; Bun's MIT
//! license, `vendor/bun/LICENSE.md`), which lives in the `bun_runtime` crate. The bundle is Bun's `typescript_libs.bin`
//! (written by `scripts/update-typescript-libs.ts`): the number of files as a `u32`, as many records sorted by name,
//! then the files, each a zstd frame of its own. Decompressing needs libzstd at link time. With
//! `--cfg ts_sema_no_builtin_libs` (`build.js --no-builtin-libs`) the bundle is empty.

use bun_sema_driver::host::BundledLibs;
use std::borrow::Cow;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};

#[cfg(not(ts_sema_no_builtin_libs))]
static BUNDLE: &[u8] = include_bytes!("../vendor/bun/src/runtime/cli/typescript_libs.bin");
/// No files.
#[cfg(ts_sema_no_builtin_libs)]
static BUNDLE: &[u8] = &[0, 0, 0, 0];

const NAME_LEN: usize = 39;

/// The length of the name, the name, where the frame starts in `BUNDLE`, its length, and its dictionary.
const RECORD_LEN: usize = 1 + NAME_LEN + 4 + 4 + 4;

fn number(bytes: &[u8]) -> usize {
    u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize
}

fn records() -> &'static [[u8; RECORD_LEN]] {
    BUNDLE[4..][..number(BUNDLE) * RECORD_LEN].as_chunks::<RECORD_LEN>().0
}

fn record_name(record: &[u8; RECORD_LEN]) -> &[u8] {
    &record[1..][..record[0] as usize]
}

/// The frame of the file `name`, and the number of its dictionary.
fn frame(name: &[u8]) -> Option<(&'static [u8], usize)> {
    let records = records();
    let found = records.binary_search_by(|record| record_name(record).cmp(name));
    let place = &records[found.ok()?][1 + NAME_LEN..];
    let frame = &BUNDLE[number(place)..][..number(&place[4..])];
    Some((frame, number(&place[8..])))
}

/// The files that are the dictionaries of the others. In a record they are 1 and 2, and 0 is none.
const DICTIONARIES: [&[u8]; 2] = [b"lib.es5.d.ts", b"lib.dom.d.ts"];

fn dictionary(index: usize) -> Option<&'static [u8]> {
    static TEXTS: [OnceLock<Option<Vec<u8>>>; 2] = [const { OnceLock::new() }; 2];
    let text = || bun_zstd::decompress_alloc(frame(DICTIONARIES[index])?.0).ok();
    TEXTS[index].get_or_init(text).as_deref()
}

/// A built-in file's text.
pub fn builtin(name: &[u8]) -> Option<Cow<'static, [u8]>> {
    if let Some(index) = DICTIONARIES.iter().position(|it| *it == name) {
        return dictionary(index).map(Cow::Borrowed);
    }
    let (frame, of) = frame(name)?;
    let text = bun_zstd::decompress_alloc_with_prefix(frame, dictionary(of.checked_sub(1)?)?);
    text.ok().map(Cow::Owned)
}

/// The built-in files' names, sorted.
pub fn builtin_names() -> impl Iterator<Item = &'static [u8]> {
    records().iter().map(record_name)
}

/// The registered set: (name, text) pairs sorted by name, borrowed from the embedder for the rest of the process.
static REGISTERED: OnceLock<Vec<(&'static [u8], &'static [u8])>> = OnceLock::new();

/// Set when the first check starts: after it, the set can't change.
pub static CHECKED: AtomicBool = AtomicBool::new(false);

/// Why `register` refused.
pub enum RegisterError {
    /// Already registered, or a check already ran.
    TooLate,
    /// Two files with the same name.
    Duplicate,
}

/// Replaces the built-in files with `files` for the rest of the process.
pub fn register(mut files: Vec<(&'static [u8], &'static [u8])>) -> Result<(), RegisterError> {
    if CHECKED.load(Ordering::SeqCst) {
        return Err(RegisterError::TooLate);
    }
    files.sort_unstable_by(|a, b| a.0.cmp(b.0));
    if files.windows(2).any(|pair| pair[0].0 == pair[1].0) {
        return Err(RegisterError::Duplicate);
    }
    REGISTERED.set(files).map_err(|_| RegisterError::TooLate)
}

fn registered(name: &[u8]) -> Option<&'static [u8]> {
    let files = REGISTERED.get()?;
    let found = files.binary_search_by(|(it, _)| (*it).cmp(name)).ok()?;
    Some(files[found].1)
}

fn has(name: &[u8]) -> bool {
    match REGISTERED.get() {
        Some(_) => registered(name).is_some(),
        None => frame(name).is_some(),
    }
}

fn read(name: &[u8]) -> Option<Cow<'static, [u8]>> {
    match REGISTERED.get() {
        Some(_) => registered(name).map(Cow::Borrowed),
        None => builtin(name),
    }
}

/// What the checker reads `lib.*.d.ts` files through when no directory is given.
pub const BUNDLED: BundledLibs = BundledLibs { has, read };
