import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const sourceDir = path.join(rootDir, 'website');
const outputDir = path.join(rootDir, 'dist', 'site');

const REQUIRED_FILES = ['index.html', 'styles.css', 'app.js', 'favicon.svg'];

export async function buildSite({ outDir = outputDir } = {}) {
  for (const file of REQUIRED_FILES) {
    const fullPath = path.join(sourceDir, file);
    try {
      await fs.access(fullPath);
    } catch {
      throw new Error(`Missing required website asset: website/${file}`);
    }
  }

  const cliPkgRaw = await fs.readFile(path.join(rootDir, 'packages', 'cli', 'package.json'), 'utf8');
  const cliPkg = JSON.parse(cliPkgRaw);
  const version = cliPkg.version || '0.1.0';

  const html = await fs.readFile(path.join(sourceDir, 'index.html'), 'utf8');

  // Verify every local relative asset referenced in index.html exists in website/
  const localRefRegex = /(?:href|src)="(\.\/[^"]+)"/g;
  for (const match of html.matchAll(localRefRegex)) {
    const relPath = match[1].replace(/^\.\//, '');
    const assetPath = path.join(sourceDir, relPath);
    try {
      await fs.access(assetPath);
    } catch {
      throw new Error(`Broken local asset reference in website/index.html: ${match[1]}`);
    }
  }

  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });
  await fs.cp(sourceDir, outDir, { recursive: true });

  const builtHtml = html.replace(/PHP-WASM CLI v[\d.]+/g, `PHP-WASM CLI v${version}`);
  await fs.writeFile(path.join(outDir, 'index.html'), builtHtml, 'utf8');
  await fs.writeFile(path.join(outDir, '.nojekyll'), '', 'utf8');

  return { outDir, version, files: [...REQUIRED_FILES, '.nojekyll'] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await buildSite();
  console.log(`Built landing page (v${result.version}) to ${path.relative(rootDir, result.outDir)}`);
}
