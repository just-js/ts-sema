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
