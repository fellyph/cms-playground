// Registry of CMS adapters (e.g. joomla, wp).

const adapters = new Map();
const aliases = new Map();

/**
 * Registers a CMS adapter so the CLI can resolve it by name or alias (e.g. --joomla, --wp, --wordpress).
 *
 * @param {object} adapter
 * @param {string} adapter.name           Canonical name (e.g. 'joomla', 'wp')
 * @param {string} adapter.label          Human-readable name (e.g. 'Joomla', 'WordPress')
 * @param {string[]} [adapter.aliases]    CLI flag aliases
 * @param {string} adapter.defaultPhp     Default PHP version (e.g. '8.4')
 * @param {string[]} adapter.supportedPhp Supported PHP versions
 * @param {string[]} [adapter.phpExtensions] Additional PHP-WASM extensions to load for this CMS
 * @param {string} adapter.defaultVersion Default CMS version
 * @param {string} adapter.adminPath      Admin URL path (e.g. '/administrator/', '/wp-admin/')
 * @param {Function} adapter.resolveBundle
 * @param {Function} adapter.configure
 * @param {Function} adapter.getFileNotFoundAction
 */
export function registerAdapter(adapter) {
  if (!adapter?.name || typeof adapter.resolveBundle !== 'function' || typeof adapter.configure !== 'function') {
    throw new Error(`Invalid CMS adapter: ${adapter?.name ?? '(unnamed)'}`);
  }

  adapters.set(adapter.name, adapter);

  for (const alias of new Set([adapter.name, ...(adapter.aliases ?? [])])) {
    aliases.set(alias.toLowerCase(), adapter.name);
  }

  return adapter;
}

/**
 * Removes a registered adapter and all of its aliases.
 */
export function unregisterAdapter(name) {
  const canonical = aliases.get(String(name).toLowerCase()) ?? name;
  const removed = adapters.delete(canonical);

  for (const [alias, target] of aliases.entries()) {
    if (target === canonical) {
      aliases.delete(alias);
    }
  }

  return removed;
}

/**
 * Looks up an adapter by canonical name or alias.
 */
export function getAdapter(nameOrAlias) {
  const canonical = aliases.get(String(nameOrAlias).toLowerCase());

  return canonical ? adapters.get(canonical) : null;
}

/**
 * Returns all registered adapters.
 */
export function listAdapters() {
  return Array.from(adapters.values());
}
