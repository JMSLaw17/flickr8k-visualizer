// Preflight for `npm run setup`: explain a missing or outdated uv before
// anything is installed. Node itself is checked by npm's engine-strict setting.
import { spawnSync } from 'node:child_process'

const REQUIRED_UV = [0, 5, 11]

const result = spawnSync('uv', ['--version'], { encoding: 'utf8' })
if (result.error || result.status !== 0) {
  console.error(
    [
      'uv is not installed or is not on your PATH. It manages the Python side of',
      'this project (see README, Prerequisites). Install it with one of:',
      '',
      '  brew install uv',
      '  curl -LsSf https://astral.sh/uv/install.sh | sh',
      '  powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"',
      '',
      'then run `npm run setup` again.',
    ].join('\n'),
  )
  process.exit(1)
}

const match = /uv (\d+)\.(\d+)\.(\d+)/.exec(result.stdout)
const version = match ? match.slice(1, 4).map(Number) : null
const olderThanRequired =
  version !== null &&
  version.some((part, index) =>
    version.slice(0, index).every((earlier, i) => earlier === REQUIRED_UV[i]) &&
    part < REQUIRED_UV[index],
  )
if (olderThanRequired) {
  console.error(
    `uv ${version.join('.')} is too old: ${REQUIRED_UV.join('.')} or newer is needed to read ` +
      'the lock file. Update it with `uv self update`, then run `npm run setup` again.',
  )
  process.exit(1)
}

console.log(`uv ${version ? version.join('.') : '(version unknown)'} found`)
