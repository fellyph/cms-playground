// Verifies publishable workspace tarballs and internal dependency version pins.
import { execFileSync } from 'node:child_process';
import { globSync, readFileSync } from 'node:fs';

const manifests = globSync('packages/*/package.json')
  .sort()
  .map((path) => ({
    path,
    manifest: JSON.parse(readFileSync(path, 'utf8')),
  }));

if (manifests.length === 0) {
  throw new Error('No workspace packages found under packages/*/package.json');
}

const versions = new Map(manifests.map(({ manifest }) => [manifest.name, manifest.version]));
const uniqueVersions = new Set(versions.values());

if (uniqueVersions.size !== 1) {
  const details = Array.from(versions.entries())
    .map(([name, ver]) => `${name}@${ver}`)
    .join(', ');
  throw new Error(`Workspace versions are out of sync: ${details}`);
}

const expectedVersion = [...uniqueVersions][0];

// Optional tag check (e.g. EXPECTED_VERSION=0.1.0 from refs/tags/v0.1.0)
if (process.env.EXPECTED_VERSION && process.env.EXPECTED_VERSION !== expectedVersion) {
  throw new Error(
    `Expected workspace version ${process.env.EXPECTED_VERSION}, but found ${expectedVersion}`
  );
}

for (const { path, manifest } of manifests) {
  for (const [dep, range] of Object.entries(manifest.dependencies ?? {})) {
    if (versions.has(dep) && range !== versions.get(dep)) {
      throw new Error(
        `Internal dependency pin mismatch in ${path}: ${dep} is "${range}", expected "${versions.get(dep)}"`
      );
    }
  }
}

const raw = execFileSync(
  process.execPath,
  [process.env.npm_execpath, 'pack', '--dry-run', '--json', '--workspaces'],
  { encoding: 'utf8' }
);

const packs = JSON.parse(raw);

if (packs.length !== manifests.length) {
  throw new Error(`Expected ${manifests.length} packed workspaces, got ${packs.length}`);
}

for (const pack of packs) {
  const paths = (pack.files ?? []).map((file) => file.path);

  if (!paths.includes('package.json')) {
    throw new Error(`${pack.name} tarball is missing package.json`);
  }

  if (!paths.includes('LICENSE')) {
    throw new Error(`${pack.name} tarball is missing LICENSE`);
  }

  for (const filePath of paths) {
    if (
      filePath.startsWith('test/') ||
      filePath.includes('/test/') ||
      filePath.includes('.test.') ||
      filePath.endsWith('.tmp') ||
      filePath.endsWith('.tgz')
    ) {
      throw new Error(`${pack.name} tarball contains disallowed file: ${filePath}`);
    }
  }
}

console.log(
  `Verified ${packs.length} workspace tarballs at v${expectedVersion}: ${packs.map((p) => p.name).join(', ')}`
);
