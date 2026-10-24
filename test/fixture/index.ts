// One type error on purpose (TS2322), and a few things that must check cleanly with the built-in es2022 libs.
const total: number = [1, 2, 3].reduce((a, b) => a + b, 0)
const names = new Map<string, number>([['a', 1]])
const label: string = total
export { names, label }
