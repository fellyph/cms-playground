#!/usr/bin/env node
// Generates the offline searchable documentation index bundled inside @cms-playground/cli.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS_DIR = join(ROOT, 'docs');
const OUT_FILE = join(ROOT, 'packages/cli/docs-index.json');

function toSlug(filename) {
  return basename(filename, '.md')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function extractTitle(markdown, fallback) {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : fallback;
}

function extractHeadings(markdown) {
  const headings = [];
  let inCodeBlock = false;

  for (const line of markdown.split(/\r?\n/)) {
    if (line.trim().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) {
      continue;
    }
    const match = line.match(/^#{2,3}\s+(.+)$/);
    if (match) {
      headings.push(match[1].trim());
    }
  }

  return headings;
}

function extractSummary(markdown) {
  const lines = markdown.split(/\r?\n/);
  let inCodeBlock = false;
  const paragraph = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) {
      continue;
    }
    if (!line) {
      if (paragraph.length > 0) {
        break;
      }
      continue;
    }
    if (line.startsWith('#') || line.startsWith('---') || line.startsWith('|') || line.startsWith('>')) {
      if (paragraph.length > 0) {
        break;
      }
      continue;
    }
    paragraph.push(line);
  }

  return paragraph
    .join(' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_`]/g, '')
    .trim();
}

export function buildDocsIndex(rootDir = ROOT) {
  const docsDir = join(rootDir, 'docs');
  const files = readdirSync(docsDir)
    .filter((f) => f.endsWith('.md'))
    .sort();

  const topics = files.map((file) => {
    const fullPath = join(docsDir, file);
    const content = readFileSync(fullPath, 'utf8');
    const slug = toSlug(file);

    return {
      slug,
      title: extractTitle(content, slug),
      summary: extractSummary(content),
      headings: extractHeadings(content),
      source: `docs/${file}`,
      content,
    };
  });

  return {
    version: 1,
    topics,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = buildDocsIndex(ROOT);
  writeFileSync(OUT_FILE, JSON.stringify(index, null, 2) + '\n', 'utf8');
  console.log(`Generated ${OUT_FILE} with ${index.topics.length} documentation topics.`);
}
