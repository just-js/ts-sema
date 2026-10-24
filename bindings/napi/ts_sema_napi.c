// N-API addon over the ts-sema C ABI (ts_sema.h): runs on Node, Bun and Deno. Built with plain cc against the vendored
// vendor/node-api-headers (no node-gyp) by `node build.js --napi`, with libts_sema.a linked in.
//
//   checkSync(project, libDir, threads) -> report JSON string
//   check(project, libDir, threads)     -> Promise of the report JSON string, checked on a libuv worker thread
//
// project: a tsconfig.json or its directory. libDir: a directory of lib.*.d.ts files, or null/undefined/"" for the
// built-in ones. threads: 0 for one per core. index.js parses the report. Checks run one at a time (a mutex): ts-sema
// hasn't been tested with concurrent checks in one process.
#define NAPI_VERSION 8
#include <node_api.h>
#include <pthread.h>
#include <stdlib.h>
#include <string.h>
#include "ts_sema.h"

static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;

#define CALL(env, call)                                                   \
  do {                                                                    \
    if ((call) != napi_ok) {                                              \
      const napi_extended_error_info *info = NULL;                        \
      napi_get_last_error_info((env), &info);                             \
      napi_throw_error((env), NULL, info && info->error_message           \
        ? info->error_message : "N-API call failed");                     \
      return NULL;                                                        \
    }                                                                     \
  } while (0)

// The arguments as owned C strings (libDir NULL when absent or empty) and a thread count.
typedef struct {
  char *project;
  char *lib_dir;
  uint32_t threads;
} args_t;

static void args_free(args_t *a) {
  free(a->project);
  free(a->lib_dir);
}

static char *string_arg(napi_env env, napi_value value, int required) {
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok) return NULL;
  if (type != napi_string) {
    if (required) napi_throw_type_error(env, NULL, "project must be a string");
    return NULL;
  }
  size_t len = 0;
  if (napi_get_value_string_utf8(env, value, NULL, 0, &len) != napi_ok) return NULL;
  if (len == 0 && !required) return NULL;
  char *s = malloc(len + 1);
  if (!s) return NULL;
  napi_get_value_string_utf8(env, value, s, len + 1, &len);
  return s;
}

static int read_args(napi_env env, napi_callback_info info, args_t *a) {
  size_t argc = 3;
  napi_value argv[3];
  memset(a, 0, sizeof(*a));
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok) return 0;
  if (argc < 1) {
    napi_throw_type_error(env, NULL, "check(project, libDir, threads): project is required");
    return 0;
  }
  a->project = string_arg(env, argv[0], 1);
  if (!a->project) return 0;
  if (argc > 1) a->lib_dir = string_arg(env, argv[1], 0);
  if (argc > 2) {
    napi_valuetype type;
    napi_typeof(env, argv[2], &type);
    if (type == napi_number) napi_get_value_uint32(env, argv[2], &a->threads);
  }
  return 1;
}

// The report, or NULL. The caller frees it with bun_sema_free.
static char *run_check(args_t *a, size_t *len) {
  pthread_mutex_lock(&lock);
  char *report = bun_sema_check(a->project, a->lib_dir, a->threads, len);
  pthread_mutex_unlock(&lock);
  return report;
}

static napi_value check_sync(napi_env env, napi_callback_info info) {
  args_t a;
  if (!read_args(env, info, &a)) {
    args_free(&a);
    return NULL;
  }
  size_t len = 0;
  char *report = run_check(&a, &len);
  args_free(&a);
  if (!report) {
    napi_throw_error(env, NULL, "ts-sema returned no report");
    return NULL;
  }
  napi_value result;
  napi_status status = napi_create_string_utf8(env, report, len, &result);
  bun_sema_free(report);
  CALL(env, status);
  return result;
}

typedef struct {
  args_t args;
  char *report;
  size_t len;
  napi_deferred deferred;
  napi_async_work work;
} job_t;

static void job_execute(napi_env env, void *data) {
  (void)env;
  job_t *job = data;
  job->report = run_check(&job->args, &job->len);
}

static void job_complete(napi_env env, napi_status status, void *data) {
  job_t *job = data;
  napi_value value;
  if (status == napi_ok && job->report &&
      napi_create_string_utf8(env, job->report, job->len, &value) == napi_ok) {
    napi_resolve_deferred(env, job->deferred, value);
  } else {
    napi_value message, error;
    napi_create_string_utf8(env, "ts-sema returned no report", NAPI_AUTO_LENGTH, &message);
    napi_create_error(env, NULL, message, &error);
    napi_reject_deferred(env, job->deferred, error);
  }
  if (job->report) bun_sema_free(job->report);
  napi_delete_async_work(env, job->work);
  args_free(&job->args);
  free(job);
}

static napi_value check_async(napi_env env, napi_callback_info info) {
  job_t *job = calloc(1, sizeof(job_t));
  if (!job) {
    napi_throw_error(env, NULL, "out of memory");
    return NULL;
  }
  if (!read_args(env, info, &job->args)) {
    args_free(&job->args);
    free(job);
    return NULL;
  }
  napi_value promise, name;
  CALL(env, napi_create_promise(env, &job->deferred, &promise));
  CALL(env, napi_create_string_utf8(env, "ts-sema check", NAPI_AUTO_LENGTH, &name));
  CALL(env, napi_create_async_work(env, NULL, name, job_execute, job_complete, job, &job->work));
  CALL(env, napi_queue_async_work(env, job->work));
  return promise;
}

NAPI_MODULE_INIT() {
  napi_property_descriptor props[] = {
    { "checkSync", NULL, check_sync, NULL, NULL, NULL, napi_enumerable, NULL },
    { "check", NULL, check_async, NULL, NULL, NULL, napi_enumerable, NULL },
  };
  CALL(env, napi_define_properties(env, exports, sizeof(props) / sizeof(props[0]), props));
  return exports;
}
