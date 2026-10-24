#pragma once
// The C ABI of ts-sema (capi/lib.rs): Bun's TypeScript checker as a library.
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// Checks the project at `project` (a tsconfig.json or its directory), with the lib.*.d.ts files in `ts_lib_dir`, or
// with ts_lib_dir NULL or "" the registered ones (bun_sema_set_libs) or else the built-in ones (the TypeScript version
// in upstream.json), on `threads` threads (0: one per core). Returns a NUL-terminated JSON report and stores its
// length (without the NUL) in *len:
//   {"ok", "errors", "files_loaded", "files_checked", "load_ms", "check_ms", "output"}
// where `output` is what `bun check --no-pretty` prints. Free it with bun_sema_free, never with free(). A panic in
// the checker aborts the process.
char *bun_sema_check(const char *project, const char *ts_lib_dir, uint32_t threads, size_t *len);
void bun_sema_free(char *report);

// Replaces the built-in lib files for the rest of the process with `count` files: names[i] (e.g. "lib.es2022.d.ts")
// and texts[i] of lens[i] bytes. Only these then exist for the checker (a tsconfig asking for another lib gets
// TypeScript's "cannot find lib" error). Nothing is copied: the names and texts must stay valid and unchanged for the
// rest of the process. Call it once, before the first check. Returns 0; -1 if a set was already registered or a
// check already ran; -2 for a null pointer or a duplicate name. A set must include what its files reference
// (`/// <reference lib="..." />`).
int bun_sema_set_libs(const char *const *names, const char *const *texts, const size_t *lens, size_t count);

// The text of the built-in lib file `name` (NULL if there is none), or with `name` NULL a JSON array of all their
// names. *len gets the length. Free it with bun_sema_free.
char *bun_sema_builtin_lib(const char *name, size_t *len);

#ifdef __cplusplus
}
#endif
