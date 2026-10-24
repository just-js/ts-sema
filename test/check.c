// Smoke test for the library: checks test/fixture with the built-in libs and expects exactly one error, TS2322 in
// index.ts. Two builds (node build.js --test does both):
//   static:   cc -Idist test/check.c dist/libts_sema.a <build.json "link"> -o check;  ./check test/fixture
//   shared:   cc -DTS_SEMA_DLOPEN -Idist test/check.c [-ldl] -o check-dl;  ./check-dl test/fixture dist/libts_sema.so
//             (dlopen + dlsym, the way an FFI loads it)
#include <stdio.h>
#include <string.h>
#include "ts_sema.h"
#ifdef TS_SEMA_DLOPEN
#include <dlfcn.h>
#endif

int main(int argc, char **argv) {
  const char *project = argc > 1 ? argv[1] : "test/fixture";
#ifndef TS_SEMA_DLOPEN
  char *(*check)(const char *, const char *, uint32_t, size_t *) = bun_sema_check;
  void (*release)(char *) = bun_sema_free;
#else
  char *(*check)(const char *, const char *, uint32_t, size_t *) = NULL;
  void (*release)(char *) = NULL;
  const char *path = argc > 2 ? argv[2] : "dist/libts_sema.so";
  void *lib = dlopen(path, RTLD_NOW | RTLD_LOCAL);
  if (!lib) {
    fprintf(stderr, "dlopen %s: %s\n", path, dlerror());
    return 2;
  }
  *(void **)&check = dlsym(lib, "bun_sema_check");
  *(void **)&release = dlsym(lib, "bun_sema_free");
  if (!check || !release) {
    fprintf(stderr, "dlsym: %s\n", dlerror());
    return 2;
  }
#endif
  size_t len = 0;
  char *report = check(project, NULL, 0, &len);
  if (!report) {
    fprintf(stderr, "no report\n");
    return 2;
  }
  printf("%.*s\n", (int)len, report);
  int ok = strstr(report, "\"errors\":1") != NULL && strstr(report, "TS2322") != NULL;
  release(report);
  fprintf(stderr, ok ? "check: ok\n" : "check: unexpected report\n");
  return ok ? 0 : 1;
}
