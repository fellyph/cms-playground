// Offline searchable documentation index and query engine for `cms-playground docs`.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORE_STEPS, CORE_STEP_SCHEMAS, listAdapters } from '@cms-playground/core';

const CLI_PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLED_INDEX_PATH = join(CLI_PACKAGE_ROOT, 'docs-index.json');

/**
 * Builds an offline Markdown reference topic for all core and adapter Blueprint steps.
 */
function buildAdapterStepsTopic() {
  const lines = [
    '# Adapter & Blueprint Steps Reference',
    '',
    'Complete offline reference of built-in core Blueprint steps and registered CMS adapter steps.',
    '',
    '## Core Steps',
    '',
  ];
  const headings = ['Core Steps'];

  for (const name of Object.keys(CORE_STEPS)) {
    const schema = CORE_STEP_SCHEMAS[name] ?? { requiredFields: [], optionalFields: [], description: '' };
    const req = schema.requiredFields?.length ? schema.requiredFields.join(', ') : 'none';
    const opt = schema.optionalFields?.length ? schema.optionalFields.join(', ') : 'none';
    lines.push(`- \`${name}\` (required: ${req}; optional: ${opt}) — ${schema.description ?? ''}`.trim());
  }

  for (const adapter of listAdapters()) {
    const sectionHeading = `${adapter.label} (--${adapter.name})`;
    headings.push(sectionHeading);
    lines.push('', `## ${sectionHeading}`, '');
    lines.push(`- Default version: \`${adapter.defaultVersion ?? 'latest'}\``);
    lines.push(`- Supported PHP: ${(adapter.supportedPhp ?? []).join(', ') || 'default'}`);
    lines.push(`- Admin path: \`${adapter.adminPath ?? '/'}\``);
    if (adapter.cliEntrypoint) {
      lines.push(`- Native CLI: \`${adapter.cliEntrypoint}\``);
    }

    const steps = Object.keys(adapter.blueprintSteps ?? {});
    if (steps.length > 0) {
      lines.push('', '### Blueprint Steps', '');
      for (const stepName of steps) {
        const schema = adapter.blueprintStepSchemas?.[stepName] ?? {};
        const req = schema.requiredFields?.length ? schema.requiredFields.join(', ') : 'none';
        const opt = schema.optionalFields?.length ? schema.optionalFields.join(', ') : 'none';
        lines.push(`- \`${stepName}\` (required: ${req}; optional: ${opt}) — ${schema.description ?? ''}`.trim());
      }
    }
  }

  return {
    slug: 'adapter-steps',
    title: 'Adapter & Blueprint Steps Reference',
    summary: 'Complete offline reference of built-in core Blueprint steps and registered CMS adapter steps.',
    headings,
    source: 'generated:adapters',
    content: lines.join('\n') + '\n',
  };
}

/**
 * Loads the bundled offline documentation catalog and appends live adapter step references.
 */
export function loadDocsCatalog(indexPath = BUNDLED_INDEX_PATH) {
  const raw = JSON.parse(readFileSync(indexPath, 'utf8'));
  const topics = Array.isArray(raw?.topics) ? [...raw.topics] : [];

  if (!topics.some((t) => t.slug === 'adapter-steps')) {
    topics.push(buildAdapterStepsTopic());
  }

  return topics;
}

function summarizeTopic(topic) {
  return {
    slug: topic.slug,
    title: topic.title,
    summary: topic.summary,
    headings: topic.headings ?? [],
    source: topic.source,
  };
}

function extractExcerpt(content, terms) {
  const lines = String(content ?? '').split(/\r?\n/);
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('```') || trimmed.startsWith('---')) {
      continue;
    }
    const lower = trimmed.toLowerCase();
    if (terms.some((t) => lower.includes(t))) {
      return trimmed.length > 160 ? `${trimmed.slice(0, 157)}...` : trimmed;
    }
  }
  return '';
}

/**
 * Queries the offline documentation catalog.
 *
 * - `--all`: returns the full catalog (including content).
 * - No query: lists all available topics.
 * - Single exact slug: returns the full page for that topic.
 * - Multi-word or partial query: scores titles, headings, summaries, and body content.
 */
export function queryDocs({ query = [], all = false } = {}, catalog = loadDocsCatalog()) {
  if (all) {
    return {
      mode: 'all',
      count: catalog.length,
      topics: catalog,
    };
  }

  const terms = (Array.isArray(query) ? query : [query])
    .flatMap((part) => String(part ?? '').trim().split(/\s+/))
    .map((t) => t.toLowerCase())
    .filter(Boolean);

  if (terms.length === 0) {
    return {
      mode: 'list',
      count: catalog.length,
      topics: catalog.map(summarizeTopic),
    };
  }

  if (terms.length === 1) {
    const exact = catalog.find((topic) => topic.slug.toLowerCase() === terms[0]);
    if (exact) {
      return {
        mode: 'exact',
        query: terms.join(' '),
        topic: exact,
      };
    }
  }

  const scored = [];

  for (const topic of catalog) {
    const slugLower = topic.slug.toLowerCase();
    const titleLower = topic.title.toLowerCase();
    const summaryLower = (topic.summary ?? '').toLowerCase();
    const headings = topic.headings ?? [];
    const headingsLower = headings.map((h) => h.toLowerCase());
    const contentLower = (topic.content ?? '').toLowerCase();

    let score = 0;
    let allMatched = true;
    const matchedHeadings = new Set();

    for (const term of terms) {
      let termScore = 0;

      if (slugLower === term) {
        termScore += 100;
      } else if (slugLower.includes(term)) {
        termScore += 50;
      }

      if (titleLower.includes(term)) {
        termScore += 40;
      }

      for (let i = 0; i < headingsLower.length; i++) {
        if (headingsLower[i].includes(term)) {
          termScore += 25;
          matchedHeadings.add(headings[i]);
        }
      }

      if (summaryLower.includes(term)) {
        termScore += 15;
      }

      if (contentLower.includes(term)) {
        termScore += 5;
      }

      if (termScore === 0) {
        allMatched = false;
        break;
      }

      score += termScore;
    }

    if (allMatched && score > 0) {
      scored.push({
        ...summarizeTopic(topic),
        score,
        matchedHeadings: Array.from(matchedHeadings),
        excerpt: extractExcerpt(topic.content, terms),
      });
    }
  }

  scored.sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug));

  return {
    mode: 'search',
    query: terms.join(' '),
    count: scored.length,
    matches: scored,
  };
}

/**
 * Formats a `queryDocs()` result for human-readable terminal output.
 */
export function formatDocsText(result, catalog = null) {
  if (result.mode === 'exact') {
    return result.topic.content.trimEnd();
  }

  if (result.mode === 'list') {
    const lines = ['Available offline documentation topics:', ''];
    for (const topic of result.topics) {
      lines.push(`  ${topic.slug.padEnd(18)} ${topic.title}`);
      if (topic.summary) {
        lines.push(`  ${' '.repeat(18)} ${topic.summary}`);
      }
    }
    lines.push(
      '',
      'Usage:',
      '  cms-playground docs <topic>           Print a full documentation page',
      '  cms-playground docs <query...>        Search titles, headings, and summaries',
      '  cms-playground docs --all --json      Output the full documentation catalog as JSON'
    );
    return lines.join('\n');
  }

  if (result.mode === 'all') {
    const sections = result.topics.map(
      (topic) => `=== ${topic.title} (${topic.slug}) ===\n\n${topic.content.trimEnd()}`
    );
    return sections.join('\n\n');
  }

  if (result.matches.length === 0) {
    const available = (catalog ?? []).map((t) => t.slug).join(', ');
    return available
      ? `No documentation matched "${result.query}". Available topics: ${available}`
      : `No documentation matched "${result.query}".`;
  }

  const lines = [`Documentation matches for "${result.query}" (${result.count}):`, ''];
  for (const match of result.matches) {
    lines.push(`  ${match.slug.padEnd(18)} ${match.title}`);
    if (match.matchedHeadings.length > 0) {
      lines.push(`  ${' '.repeat(18)} Headings: ${match.matchedHeadings.slice(0, 4).join(' | ')}`);
    } else if (match.summary) {
      lines.push(`  ${' '.repeat(18)} ${match.summary}`);
    }
    if (match.excerpt) {
      lines.push(`  ${' '.repeat(18)} > ${match.excerpt}`);
    }
  }
  lines.push('', 'Run `cms-playground docs <slug>` to view a full page.');
  return lines.join('\n');
}
