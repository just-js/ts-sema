// N-API addon over the ts-sema C ABI (ts_sema.h): runs on Node, Bun and Deno. Built with plain cc against the vendored
// vendor/node-api-headers (no node-gyp) by `node build.js --napi`, with libts_sema.a linked in.
//
//   checkSync(project, libDir, threads) -> report JSON string
//   check(project, libDir, threads)     -> Promise of the report JSON string, checked on a libuv worker thread
//   setLibs(names, texts)               -> replaces the built-in lib files (arrays of strings); copied once, kept
//   builtinLib(name)                    -> a built-in lib file's text, or null; with no name, a JSON array of names
//
// The same file is also a plain shared library for any FFI: it exports bun_sema_check/bun_sema_free (ts_sema.h), and
// its references to N-API are weak, so dlopen succeeds in processes without N-API (Python ctypes, C, RTLD_NOW); the
// napi_* functions are only called when Node or Bun loads it as an addon.
//
// project: a tsconfig.json or its directory. libDir: a directory of lib.*.d.ts files, or null/undefined/"" for the
// built-in ones. threads: 0 for one per core. index.js parses the report. Checks run one at a time (a mutex): ts-sema
// hasn't been tested with concurrent checks in one process.
#define NAPI_VERSION 8
#include <node_api.h>
#include <pthread.h>
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>
#include "ts_sema.h"

// Every N-API function used below: weak references (null when no N-API host is loaded).
#pragma weak napi_create_async_work
#pragma weak napi_create_error
#pragma weak napi_create_promise
#pragma weak napi_create_string_utf8
#pragma weak napi_define_properties
#pragma weak napi_delete_async_work
#pragma weak napi_get_cb_info
#pragma weak napi_get_last_error_info
#pragma weak napi_get_value_string_utf8
#pragma weak napi_get_value_uint32
#pragma weak napi_queue_async_work
#pragma weak napi_reject_deferred
#pragma weak napi_resolve_deferred
#pragma weak napi_throw_error
#pragma weak napi_throw_type_error
#pragma weak napi_typeof
#pragma weak napi_get_array_length
#pragma weak napi_get_element
#pragma weak napi_get_null
#pragma weak napi_is_exception_pending
#pragma weak napi_get_undefined

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

// A JS string as an owned UTF-8 C string (its byte length in *out_len when given). required: throw a TypeError for a
// non-string, else return NULL for one (and for ""). no_nul: throw a TypeError for a string with a NUL character
// (paths and lib names: C would see only the part before it; Node's fs rejects those too).
static char *string_arg(napi_env env, napi_value value, int required, int no_nul, size_t *out_len) {
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok) return NULL;
  if (type != napi_string) {
    if (required) napi_throw_type_error(env, NULL, "expected a string");
    return NULL;
  }
  size_t len = 0;
  if (napi_get_value_string_utf8(env, value, NULL, 0, &len) != napi_ok) return NULL;
  if (len == 0 && !required) return NULL;
  char *s = malloc(len + 1);
  if (!s) {
    napi_throw_error(env, NULL, "out of memory");
    return NULL;
  }
  napi_get_value_string_utf8(env, value, s, len + 1, &len);
  if (no_nul && strlen(s) != len) {
    free(s);
    napi_throw_type_error(env, NULL, "expected a string without NUL characters");
    return NULL;
  }
  if (out_len) *out_len = len;
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
  a->project = string_arg(env, argv[0], 1, 1, NULL);
  if (!a->project) return 0;
  if (argc > 1) {
    a->lib_dir = string_arg(env, argv[1], 0, 1, NULL);
    bool pending = false;
    napi_is_exception_pending(env, &pending);
    if (pending) return 0;
  }
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

// setLibs(names, texts): copies the strings into memory that is never freed (bun_sema_set_libs borrows them).
static napi_value set_libs(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  uint32_t count = 0, texts_count = 0;
  if (argc < 2 || napi_get_array_length(env, argv[0], &count) != napi_ok ||
      napi_get_array_length(env, argv[1], &texts_count) != napi_ok || count != texts_count) {
    napi_throw_type_error(env, NULL, "setLibs(names, texts): two arrays of strings of the same length");
    return NULL;
  }
  const char **names = calloc(count ? count : 1, sizeof(char *));
  const char **texts = calloc(count ? count : 1, sizeof(char *));
  size_t *lens = calloc(count ? count : 1, sizeof(size_t));
  int ok = names && texts && lens;
  for (uint32_t i = 0; ok && i < count; i++) {
    napi_value name, text;
    ok = napi_get_element(env, argv[0], i, &name) == napi_ok && napi_get_element(env, argv[1], i, &text) == napi_ok;
    size_t text_len = 0;
    char *n = ok ? string_arg(env, name, 1, 1, NULL) : NULL;
    char *t = n ? string_arg(env, text, 1, 0, &text_len) : NULL;
    if (!n || !t) {
      free(n);
      free(t);
      ok = 0;
      break;
    }
    names[i] = n;
    texts[i] = t;
    lens[i] = text_len;
  }
  int result = ok ? bun_sema_set_libs(names, texts, lens, count) : -2;
  if (result != 0) {
    for (uint32_t i = 0; i < count && names && texts; i++) {
      free((void *)names[i]);
      free((void *)texts[i]);
    }
    free(names);
    free(texts);
    free(lens);
    bool pending = false;
    napi_is_exception_pending(env, &pending);
    if (!pending) {
      napi_throw_error(env, NULL, result == -1 ? "setLibs: already set, or a check already ran"
        : "setLibs: a name or text isn't a string, or a name appears twice");
    }
    return NULL;
  }
  napi_value undefined;
  CALL(env, napi_get_undefined(env, &undefined));
  return undefined;
}

static napi_value builtin_lib(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  CALL(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  char *name = argc > 0 ? string_arg(env, argv[0], 0, 1, NULL) : NULL;
  bool pending = false;
  napi_is_exception_pending(env, &pending);
  if (pending) return NULL;
  size_t len = 0;
  char *text = bun_sema_builtin_lib(name, &len);
  free(name);
  napi_value result;
  if (!text) {
    CALL(env, napi_get_null(env, &result));
    return result;
  }
  napi_status status = napi_create_string_utf8(env, text, len, &result);
  bun_sema_free(text);
  CALL(env, status);
  return result;
}

NAPI_MODULE_INIT() {
  napi_property_descriptor props[] = {
    { "checkSync", NULL, check_sync, NULL, NULL, NULL, napi_enumerable, NULL },
    { "check", NULL, check_async, NULL, NULL, NULL, napi_enumerable, NULL },
    { "setLibs", NULL, set_libs, NULL, NULL, NULL, napi_enumerable, NULL },
    { "builtinLib", NULL, builtin_lib, NULL, NULL, NULL, napi_enumerable, NULL },
  };
  CALL(env, napi_define_properties(env, exports, sizeof(props) / sizeof(props[0]), props));
  return exports;
}
