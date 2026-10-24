//! A C ABI for `bun_sema`, Bun's TypeScript checker (not part of Bun). The header is `include/ts_sema.h`.
//!
//! ```c
//! // Checks the project at `project` (a tsconfig.json or its directory), with the lib.*.d.ts files in
//! // `ts_lib_dir` (NULL or "": TypeScript 7.0.2's, built in like `bun check`'s), on `threads` threads
//! // (0: one per core; more than the core count counts as the core count).
//! // Returns a NUL-terminated JSON report and stores its length (without the NUL) in *len. Free it with
//! // bun_sema_free.
//! char *bun_sema_check(const char *project, const char *ts_lib_dir, uint32_t threads, size_t *len);
//! void bun_sema_free(char *report);
//! // Replaces the built-in lib files with `count` borrowed ones for the rest of the process (before the first check).
//! int bun_sema_set_libs(const char *const *names, const char *const *texts, const size_t *lens, size_t count);
//! // A built-in lib file's text, or with `name` NULL a JSON array of their names. Free it with bun_sema_free.
//! char *bun_sema_builtin_lib(const char *name, size_t *len);
//! ```
//!
//! The report: `{"ok", "errors", "files_loaded", "files_checked", "load_ms", "check_ms", "output"}`, where `output`
//! is the diagnostics and summary as `bun check --no-pretty` prints them. Built with `panic = "abort"`: a panic in the
//! checker ends the calling process.

use bun_sema_driver::format::{Layout, Style, write_diagnostics, write_summary};
use std::ffi::{CStr, CString, c_char};
use std::fmt::Write as _;

mod libs;

// With `--cfg bun_sema_mimalloc` (build.js's default `--variant mimalloc`) the real mimalloc (Bun's fork) replaces
// Bun's stand-in heaps, and Rust's own heap uses it too, as in `bun check`. Otherwise Rust's heap is the system malloc.
#[cfg(bun_sema_mimalloc)]
#[global_allocator]
static ALLOC: bun_alloc::Mimalloc = bun_alloc::Mimalloc;

/// Appends `s` as a JSON string literal.
fn json_string(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

fn check(project: &[u8], ts_lib_dir: Option<&[u8]>, threads: u32) -> String {
    // The main thread's stack is at least 8 MB on Linux, as for `bun-sema`.
    bun_sema_standalone::native::set_stack_size(7 << 20);
    let cwd = std::env::current_dir().unwrap().to_string_lossy().into_owned();
    let arguments: [&[u8]; 2] = [b"-p", project];
    let command_line = bun_sema_driver::parse_command_line(&arguments, cwd.as_bytes());
    let request = bun_sema_driver::Request {
        compiler_options: &command_line.compiler_options,
        cwd: cwd.as_bytes(),
        project: command_line.project.as_deref(),
        listed_projects: None,
        build: command_line.build,
        errors: &command_line.errors,
        paths: &command_line.paths,
        are_entry_points: false,
        threads: threads as usize,
        libs: match ts_lib_dir {
            Some(dir) => bun_sema_driver::Libs::Directory(dir),
            None => bun_sema_driver::Libs::Bundled(libs::BUNDLED),
        },
        progress: None,
        order: 1,
        plan_options: bun_sema_driver::PlanOptions::default(),
        script_kinds: &[],
        script_kinds_by_extension: &[],
        conditions: &[],
        stops_like_tsc: true,
        uses_typescript_wording: false,
        after_file: None,
    };
    // The caller's process continues after the check (`Provided::ends_the_process` stays false).
    let provided = bun_sema_driver::host::Provided::default();
    let mut text = Vec::new();
    let report = bun_sema_driver::check_provided_then(&request, provided, |report| {
        let cwd = bun_sema_driver::host::from_native(cwd.as_bytes());
        let style = Style {
            layout: Layout::Plain,
            color: false,
            cwd: &cwd,
            is_case_sensitive: report.is_case_sensitive,
            github_annotations: false,
            width: 0,
            show_all: true,
        };
        write_diagnostics(&mut text, &report, &style);
        write_summary(&mut text, &report, &style);
        report
    });
    let mut json = String::new();
    let _ = write!(
        json,
        "{{\"ok\":{},\"errors\":{},\"files_loaded\":{},\"files_checked\":{},\"load_ms\":{:.3},\"check_ms\":{:.3},\"output\":",
        report.is_ok(),
        report.error_count(),
        report.files_loaded,
        report.files_checked,
        report.load_time.as_secs_f64() * 1000.0,
        report.check_time.as_secs_f64() * 1000.0,
    );
    json_string(&mut json, &String::from_utf8_lossy(&text));
    json.push('}');
    json
}

/// # Safety
/// `project` is a NUL-terminated string, `ts_lib_dir` one or null; `len` is null or points to a `size_t`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bun_sema_check(
    project: *const c_char,
    ts_lib_dir: *const c_char,
    threads: u32,
    len: *mut usize,
) -> *mut c_char {
    // SAFETY: the caller passes NUL-terminated strings, and `ts_lib_dir` may be null (this function's contract).
    let project = unsafe { CStr::from_ptr(project) };
    let ts_lib_dir = (!ts_lib_dir.is_null())
        .then(|| unsafe { CStr::from_ptr(ts_lib_dir) }.to_bytes())
        .filter(|dir| !dir.is_empty());
    libs::CHECKED.store(true, std::sync::atomic::Ordering::SeqCst);
    // At most one thread per core: Bun's pool has no more, and the driver sizes per-thread state by this number (a JS
    // caller's -1 >>> 0, 4294967295, made it allocate 12 GB and abort the process). 0 still means one per core.
    let cores = std::thread::available_parallelism().map_or(1, |n| n.get());
    let threads = threads.min(u32::try_from(cores).unwrap_or(u32::MAX));
    let json = check(project.to_bytes(), ts_lib_dir, threads);
    if !len.is_null() {
        // SAFETY: a non-null `len` points to a `size_t` (this function's contract).
        unsafe { *len = json.len() };
    }
    // The report is built from `String::from_utf8_lossy` and `write!`, so it holds no NUL.
    CString::new(json).unwrap().into_raw()
}

/// # Safety
/// `report` is null or a pointer `bun_sema_check` returned, not freed before.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bun_sema_free(report: *mut c_char) {
    if !report.is_null() {
        // SAFETY: it came from `CString::into_raw` in `bun_sema_check` (this function's contract).
        drop(unsafe { CString::from_raw(report) });
    }
}

/// Returns 0, -1 if a set was already registered or a check already ran, or -2 for a null pointer or a name twice.
///
/// # Safety
/// `names`, `texts` and `lens` each point to `count` elements (or `count` is 0); each name is NUL-terminated and each
/// text is `lens[i]` bytes of UTF-8. All of it is borrowed, not copied: it must stay valid and unchanged for the rest
/// of the process (embedded data, or memory never freed).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bun_sema_set_libs(
    names: *const *const c_char,
    texts: *const *const c_char,
    lens: *const usize,
    count: usize,
) -> i32 {
    if count > 0 && (names.is_null() || texts.is_null() || lens.is_null()) {
        return -2;
    }
    let mut files = Vec::with_capacity(count);
    for i in 0..count {
        // SAFETY: each array has `count` elements (this function's contract).
        let (name, text, len) = unsafe { (*names.add(i), *texts.add(i), *lens.add(i)) };
        if name.is_null() || (text.is_null() && len > 0) {
            return -2;
        }
        // SAFETY: NUL-terminated names and `len`-byte texts that outlive the process's checks (this function's
        // contract), so 'static is what the caller promises.
        let name: &'static [u8] = unsafe { CStr::from_ptr(name) }.to_bytes();
        let text: &'static [u8] = if len == 0 { &[] } else { unsafe { std::slice::from_raw_parts(text.cast(), len) } };
        files.push((name, text));
    }
    match libs::register(files) {
        Ok(()) => 0,
        Err(libs::RegisterError::TooLate) => -1,
        Err(libs::RegisterError::Duplicate) => -2,
    }
}

/// # Safety
/// `name` is null or NUL-terminated; `len` is null or points to a `size_t`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bun_sema_builtin_lib(name: *const c_char, len: *mut usize) -> *mut c_char {
    let bytes = if name.is_null() {
        let mut json = String::from("[");
        for (i, name) in libs::builtin_names().enumerate() {
            if i > 0 {
                json.push(',');
            }
            json_string(&mut json, &String::from_utf8_lossy(name));
        }
        json.push(']');
        json.into_bytes()
    } else {
        // SAFETY: a non-null `name` is NUL-terminated (this function's contract).
        match libs::builtin(unsafe { CStr::from_ptr(name) }.to_bytes()) {
            Some(text) => text.into_owned(),
            None => return std::ptr::null_mut(),
        }
    };
    let Ok(text) = CString::new(bytes) else {
        return std::ptr::null_mut();
    };
    if !len.is_null() {
        // SAFETY: a non-null `len` points to a `size_t` (this function's contract).
        unsafe { *len = text.as_bytes().len() };
    }
    text.into_raw()
}
