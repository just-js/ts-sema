# patches

Our changes to the vendored sources, applied by `sync.js` after it copies them:
`patches/bun/*.patch` to `vendor/bun`, `patches/mimalloc/*.patch` to
`vendor/mimalloc`, in name order, paths relative to the upstream repo's root
(`git apply --directory=vendor/<name>`). None yet: `capi/` only uses Bun's
public crate APIs.
