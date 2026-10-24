export interface CheckOptions {
  /** A directory of TypeScript lib.*.d.ts files; default: the built-in ones (the TypeScript version ts-sema was built with). */
  libDir?: string
  /** Checker threads; 0 or unset: one per core. */
  threads?: number
}

export interface Report {
  /** No errors. */
  ok: boolean
  errors: number
  files_loaded: number
  files_checked: number
  load_ms: number
  check_ms: number
  /** The diagnostics and summary, as `bun check --no-pretty` prints them. */
  output: string
}

/** Checks the project (a tsconfig.json or its directory) on a worker thread. */
export function check (project: string, options?: CheckOptions): Promise<Report>
/** Checks the project (a tsconfig.json or its directory) on the calling thread. */
export function checkSync (project: string, options?: CheckOptions): Report
/** The path of the addon, which is also a plain shared library exporting bun_sema_check/bun_sema_free, for any FFI. */
export const libraryPath: string
/** Replaces the built-in lib files for the rest of the process (once, before the first check): { 'lib.es2022.d.ts': text }. */
export function setLibs (libs: Record<string, string>): void
/** The names of the built-in lib files. */
export function builtinLibNames (): string[]
/** A built-in lib file's text, by file name or tsconfig "lib" name, or null. */
export function builtinLib (name: string): string | null
/** Built-in lib files by tsconfig "lib" name, plus every file they reference, for setLibs(). */
export function builtinLibSet (names: string[]): Record<string, string>
