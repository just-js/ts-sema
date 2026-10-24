//! A C ABI for `bun_sema`, Bun's TypeScript checker (not part of Bun). The header is `include/ts_sema.h`.
//!
//! ```c
//! // Checks the project at `project` (a tsconfig.json or its directory), with the lib.*.d.ts files in
//! // `ts_lib_dir` (NULL or "": TypeScript 7.0.2's, built in like `bun check`'s), on `threads` threads
//! // (0: one per core). Returns a NUL-terminated JSON report and stores its
//! // length (without the NUL) in *len. Free it with bun_sema_free.
//! char *bun_sema_check(const char *project, const char *ts_lib_dir, uint32_t threads, size_t *len);
//! void bun_sema_free(char *report);
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
