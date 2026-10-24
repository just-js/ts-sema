#pragma once
// The C ABI of ts-sema (capi/lib.rs): Bun's TypeScript checker as a library.
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// Checks the project at `project` (a tsconfig.json or its directory), with the lib.*.d.ts files in `ts_lib_dir`
// (NULL or "": the TypeScript version in upstream.json, built in), on `threads` threads (0: one per core). Returns a
// NUL-terminated JSON report and stores its length (without the NUL) in *len:
//   {"ok", "errors", "files_loaded", "files_checked", "load_ms", "check_ms", "output"}
// where `output` is what `bun check --no-pretty` prints. Free it with bun_sema_free, never with free(). A panic in
// the checker aborts the process.
char *bun_sema_check(const char *project, const char *ts_lib_dir, uint32_t threads, size_t *len);
void bun_sema_free(char *report);

#ifdef __cplusplus
}
#endif
