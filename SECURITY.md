# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately, through GitHub's private vulnerability
reporting: the **Security** tab of
[just-js/ts-sema](https://github.com/just-js/ts-sema/security), then **Report a
vulnerability**. Please don't open a public issue for one.

A fix goes into a new release, and the advisory is published with it.

ts-sema builds Bun's checker from unmodified Bun sources (`vendor/bun`, pinned
in `upstream.json`). A problem in the checker itself is usually Bun's: report it
to [oven-sh/bun](https://github.com/oven-sh/bun/security) too, or tell us and
we'll pass it on. We pick up Bun's fix by re-vendoring (`sync.js`).

## Supported versions

ts-sema is pre-1.0: only the latest release gets fixes, on GitHub and on npm
(`@beardsoft/ts-sema` and its platform packages).

## Verifying a release

Every release asset is built in GitHub Actions (`release.yml`) and comes with a
signed SLSA build provenance attestation:

```sh
gh release verify <version> -R just-js/ts-sema          # immutable, with GitHub's release attestation (0.0.3+)
gh attestation verify ts-sema-<target>.tar.gz -R just-js/ts-sema
sha256sum -c --ignore-missing SHA256SUMS
```

or all checks at once, including npm's, from a clone: `node verify.js <version> --npm`.

The npm packages are published from the same workflow with npm trusted
publishing, each with a provenance attestation, and approved by a maintainer
with 2FA. In a project that installed them:

```sh
npm audit signatures
```

reports verified registry signatures and verified attestations for
`@beardsoft/ts-sema` and the platform package npm installed.
