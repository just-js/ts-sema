// Smoke test for the static library: checks test/fixture with the built-in libs and expects exactly one error,
// TS2322 in index.ts. Build: cc -Idist test/check.c dist/libts_sema.a <build.json "link"> -o check; run: ./check
#include <stdio.h>
#include <string.h>
#include "ts_sema.h"

int main(int argc, char **argv) {
  const char *project = argc > 1 ? argv[1] : "test/fixture";
  size_t len = 0;
  char *report = bun_sema_check(project, NULL, 0, &len);
  if (!report) {
    fprintf(stderr, "no report\n");
    return 2;
  }
  printf("%.*s\n", (int)len, report);
  int ok = strstr(report, "\"errors\":1") != NULL && strstr(report, "TS2322") != NULL;
  bun_sema_free(report);
  fprintf(stderr, ok ? "check: ok\n" : "check: unexpected report\n");
  return ok ? 0 : 1;
}
