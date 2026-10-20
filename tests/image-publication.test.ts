import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const image = 'registry.invalid/bunko';
const amd64Digest = `sha256:${'a'.repeat(64)}`;
const arm64Digest = `sha256:${'b'.repeat(64)}`;
function candidate(architecture: string, digit: string) {
  return {
    manifests: [
      { digest: `sha256:${digit.repeat(64)}`, platform: { os: 'linux', architecture } },
      {
        digest: `sha256:${digit.repeat(63)}0`,
        platform: { os: 'unknown', architecture: 'unknown' },
        annotations: { 'vnd.docker.reference.type': 'attestation-manifest' },
      },
    ],
  };
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'bunko-publication-'));
  directories.push(directory);
  const amd64 = candidate('amd64', 'c');
  const arm64 = candidate('arm64', 'd');
  const merged = { manifests: [...amd64.manifests, ...arm64.manifests] };
  // Only the Docker boundary is synthetic. Run the actual shell/jq promotion
  // checks, recording any attempt to move a public tag. No registry is contacted.
  writeFileSync(
    join(directory, 'docker'),
    `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const dir = process.env.PUBLICATION_FIXTURE;
if (args.slice(0, 3).join(' ') === 'buildx imagetools inspect') {
  const arch = args.at(-1).endsWith(process.env.AMD64_DIGEST) ? 'amd64' : 'arm64';
  process.stdout.write(fs.readFileSync(path.join(dir, arch + '.json')));
} else if (args.slice(0, 3).join(' ') === 'buildx imagetools create') {
  if (args.includes('--dry-run')) process.stdout.write(fs.readFileSync(path.join(dir, 'merged.json')));
  else fs.appendFileSync(path.join(dir, 'published.jsonl'), JSON.stringify(args) + '\\n');
} else process.exit(99);
`,
    { mode: 0o755 },
  );
  writeFileSync(join(directory, 'published.jsonl'), '');
  return {
    amd64,
    arm64,
    merged,
    run(overrides: Record<string, string | undefined> = {}) {
      for (const [name, value] of Object.entries({ amd64, arm64, merged })) {
        writeFileSync(join(directory, `${name}.json`), JSON.stringify(value));
      }
      const result = spawnSync('bash', [resolve('scripts/publish-image.sh')], {
        encoding: 'utf8',
        timeout: 5_000,
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          PUBLICATION_FIXTURE: directory,
          IMAGE: image,
          AMD64_DIGEST: amd64Digest,
          ARM64_DIGEST: arm64Digest,
          IMAGE_METADATA: JSON.stringify({ tags: [`${image}:latest`, `${image}:sha-fixture`] }),
          ...overrides,
        },
      });
      const publications = readFileSync(join(directory, 'published.jsonl'), 'utf8').trim();
      return { ...result, publications };
    },
  };
}

it('promotes both verified digests and requested tags without running another build', () => {
  const result = fixture().run();
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.publications)).toEqual([
    'buildx',
    'imagetools',
    'create',
    '--tag',
    `${image}:latest`,
    '--tag',
    `${image}:sha-fixture`,
    `${image}@${amd64Digest}`,
    `${image}@${arm64Digest}`,
  ]);
});

it('does not move tags when the ARM candidate contains the wrong native architecture', () => {
  const test = fixture();
  test.arm64.manifests[0].platform.architecture = 'amd64';
  const result = test.run();
  expect(result.status).not.toBe(0);
  expect(result.publications).toBe('');
});

it('does not move tags when a candidate has lost its attestations', () => {
  const test = fixture();
  test.arm64.manifests.pop();
  const result = test.run();
  expect(result.status).not.toBe(0);
  expect(result.publications).toBe('');
});

it('does not move tags if merging drops an image or attestation descriptor', () => {
  const test = fixture();
  test.merged.manifests.pop();
  const result = test.run();
  expect(result.status).not.toBe(0);
  expect(result.publications).toBe('');
});

it.each([
  { AMD64_DIGEST: 'sha256:invalid' },
  { ARM64_DIGEST: amd64Digest },
  { IMAGE_METADATA: JSON.stringify({ tags: ['registry.invalid/other:latest'] }) },
  { IMAGE_METADATA: '{"tags":["registry.invalid/bunko:latest"],"broken":' },
  { IMAGE_METADATA: JSON.stringify({ tags: [] }) },
])('rejects invalid promotion inputs before moving any tags: %j', (overrides) => {
  const result = fixture().run(overrides);
  expect(result.status).not.toBe(0);
  expect(result.publications).toBe('');
});
