#!/usr/bin/env node
// Tags main as a ts-sema version, pushes the tag, and publishes the GitHub release that starts the release build
// (.github/workflows/release.yml: build, SHA256SUMS, attestations, assets). Node 20+, no dependencies.
//
//   node release.js [--dry-run] <version>        e.g. node release.js 0.0.1
//
// The tag is the version as given (like lo's). Needs $GH_TOKEN or $GITHUB_TOKEN (Contents: Read and write). Local main
// must equal origin/main and be clean, and the push build of that commit must have passed. --dry-run does every check
// and prints what would happen. Re-running when the tag is already on origin at the same commit only publishes.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

function fail (msg) {
  console.error(`release: ${msg}`)
  process.exit(1)
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const [version] = args.filter(a => !a.startsWith('--'))
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version) || args.some(a => a.startsWith('--') && a !== '--dry-run')) {
  fail('usage: node release.js [--dry-run] <version>   (version like 0.0.1)')
}
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
if (!token) fail('needs $GH_TOKEN or $GITHUB_TOKEN')

const m = git('remote', 'get-url', 'origin').match(/github\.com[:/]([^/]+\/[^/]+?)(\.git)?$/)
if (!m) fail("can't get owner/repo from the origin remote")
const repo = m[1]
const api = `https://api.github.com/repos/${repo}`
const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', Authorization: `Bearer ${token}` }

git('fetch', '-q', '--tags', 'origin')
if (git('rev-parse', '--abbrev-ref', 'HEAD') !== 'main') fail('not on main')
if (git('status', '--porcelain')) fail('the working tree has changes')
const sha = git('rev-parse', 'HEAD')
if (sha !== git('rev-parse', 'origin/main')) fail('local main is not origin/main; pull or push first')

// The push build ("build on push") of this commit must have passed.
const runs = await (await fetch(`${api}/actions/runs?head_sha=${sha}&event=push&per_page=20`, { headers })).json()
const push = (runs.workflow_runs || []).find(r => r.name === 'build on push')
if (!push) fail(`no push build for ${sha.slice(0, 7)}`)
if (push.conclusion !== 'success') fail(`the push build for ${sha.slice(0, 7)} is ${push.status}/${push.conclusion}: ${push.html_url}`)

const remote = git('ls-remote', '--tags', 'origin', `refs/tags/${version}`).split('\t')[0]
if (remote && remote !== sha) fail(`tag ${version} already exists on origin at ${remote}`)
if (!remote && git('tag', '--list', version)) fail(`tag ${version} exists locally but not on origin`)

const existing = await fetch(`${api}/releases/tags/${version}`, { headers })
if (existing.status !== 404) fail(`release ${version} already exists (HTTP ${existing.status})`)

const up = JSON.parse(readFileSync(new URL('./upstream.json', import.meta.url), 'utf8'))
const body = [
  `- Bun ${up.bun.version} ([${up.bun.commit.slice(0, 10)}](https://github.com/oven-sh/bun/commit/${up.bun.commit})), TypeScript ${up.typescript}`,
  `- Built with Rust ${up.rust_toolchain}; assets: \`ts-sema-<target>.tar.gz\` (static + shared library, \`ts_sema.node\`, header, \`build.json\`), \`SHA256SUMS\``,
  `- Verify: \`gh attestation verify ts-sema-<target>.tar.gz -R ${repo}\``
].join('\n')
const payload = { tag_name: version, name: version, body, draft: false, prerelease: false }

if (dryRun) {
  console.log(`would ${remote ? '' : `tag ${sha} as ${version}, push the tag, and `}publish release ${version} on ${repo}:`)
  console.log(JSON.stringify(payload, null, 2))
  process.exit(0)
}

if (!remote) {
  git('tag', '-a', version, '-m', `ts-sema ${version}`, sha)
  git('push', '-q', 'origin', `refs/tags/${version}`)
  console.log(`tagged ${sha} as ${version} and pushed`)
}
const res = await fetch(`${api}/releases`, { method: 'POST', headers, body: JSON.stringify(payload) })
if (res.status !== 201) fail(`creating release ${version} failed (HTTP ${res.status}): ${await res.text()}`)
console.log(`published release ${version}: ${(await res.json()).html_url}`)
console.log(`release build: https://github.com/${repo}/actions/workflows/release.yml`)
