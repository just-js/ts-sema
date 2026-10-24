// ts-sema through Deno's FFI (Deno.dlopen):
//   deno run --allow-ffi deno.ts <libts_sema.so|.dylib> <tsconfig.json or project dir>
const [library, project] = Deno.args
const lib = Deno.dlopen(library, {
  // char *bun_sema_check(const char *project, const char *ts_lib_dir, uint32_t threads, size_t *len)
  bun_sema_check: { parameters: ['buffer', 'pointer', 'u32', 'buffer'], result: 'pointer' },
  bun_sema_free: { parameters: ['pointer'], result: 'void' },
})
const len = new BigUint64Array(1)
// ts_lib_dir null: the built-in lib.*.d.ts files; threads 0: one per core.
const report = lib.symbols.bun_sema_check(new TextEncoder().encode(`${project}\0`), null, 0, len)
if (report === null) throw new Error('ts-sema returned no report')
const json = JSON.parse(new Deno.UnsafePointerView(report).getCString())
lib.symbols.bun_sema_free(report)
lib.close()
console.log(json.output)
Deno.exitCode = json.ok ? 0 : 1
