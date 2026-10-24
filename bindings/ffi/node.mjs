// ts-sema through Node's built-in FFI (node:ffi, Node 26.1+, experimental):
//   node node.mjs <libts_sema.so|.dylib> <tsconfig.json or project dir>
import { dlopen, toString } from 'node:ffi'

const [library, project] = process.argv.slice(2)
const { lib, functions } = dlopen(library, {
  // char *bun_sema_check(const char *project, const char *ts_lib_dir, uint32_t threads, size_t *len)
  bun_sema_check: { arguments: ['string', 'pointer', 'uint32', 'buffer'], return: 'pointer' },
  bun_sema_free: { arguments: ['pointer'], return: 'void' }
})
const len = new BigUint64Array(1)
// ts_lib_dir null: the built-in lib.*.d.ts files; threads 0: one per core.
const report = functions.bun_sema_check(project, null, 0, len)
const json = JSON.parse(toString(report))
functions.bun_sema_free(report)
lib.close()
console.log(json.output)
process.exitCode = json.ok ? 0 : 1
