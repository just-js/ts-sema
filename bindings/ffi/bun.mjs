// ts-sema through Bun's FFI (bun:ffi):
//   bun bun.mjs <libts_sema.so|.dylib> <tsconfig.json or project dir>
import { dlopen, ptr, CString } from 'bun:ffi'

const [library, project] = process.argv.slice(2)
const { symbols, close } = dlopen(library, {
  // char *bun_sema_check(const char *project, const char *ts_lib_dir, uint32_t threads, size_t *len)
  bun_sema_check: { args: ['cstring', 'ptr', 'u32', 'ptr'], returns: 'ptr' },
  bun_sema_free: { args: ['ptr'], returns: 'void' }
})
const len = new BigUint64Array(1)
// ts_lib_dir null: the built-in lib.*.d.ts files; threads 0: one per core.
const report = symbols.bun_sema_check(Buffer.from(`${project}\0`), null, 0, ptr(len))
const json = JSON.parse(new CString(report, 0, Number(len[0])).toString())
symbols.bun_sema_free(report)
close()
console.log(json.output)
process.exitCode = json.ok ? 0 : 1
