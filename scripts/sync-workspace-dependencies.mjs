// Keep exact internal dependency pins aligned after npm version --workspaces.
import { globSync, readFileSync, writeFileSync } from 'node:fs';

const workspaces = globSync('packages/*/package.json').map((path) => ({
  path,
  manifest: JSON.parse(readFileSync(path, 'utf8')),
}));
const versions = new Map(workspaces.map(({ manifest }) => [manifest.name, manifest.version]));

for (const { path, manifest } of workspaces) {
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    if (versions.has(name)) manifest.dependencies[name] = versions.get(name);
  }
  writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n');
}
