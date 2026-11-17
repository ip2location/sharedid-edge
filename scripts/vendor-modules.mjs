// The vendor modules in packages/vendor-modules/ and what their sharedidEdge blocks declare about the network and
// build-time credentials (see packages/vendor-modules/AGENTS.md, "Offline modules and build-time credentials"), and
// every opt-in module (vendor modules and the project's opt-in modules), for the conformance suite's build.
// Plain Node.js, no TypeScript: the bundled adapters' deploy builds use it.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const root = join(import.meta.dirname, '..');
const VENDOR_DIR = join(root, 'packages/vendor-modules');

/**
 * Every vendor module's folder (relative, `/` separators) and `sharedidEdge` block.
 *
 * @returns {{ folder: string, meta: { network?: unknown, buildCredentials?: unknown } }[]}
 */
export function vendorModules() {
  if (!existsSync(VENDOR_DIR)) return [];
  return readdirSync(VENDOR_DIR, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(join(VENDOR_DIR, entry.name, 'package.json')))
    .map(entry => ({
      folder: `packages/vendor-modules/${entry.name}`,
      meta: JSON.parse(readFileSync(join(VENDOR_DIR, entry.name, 'package.json'), 'utf8')).sharedidEdge ?? {}
    }));
}

/**
 * The hosts a module may reach, from `network`: `[]` for `"none"`, the list for a list of hosts, and `undefined`
 * when it's missing or malformed (docs.mjs reports that).
 *
 * @param {unknown} network
 * @returns {string[] | undefined}
 */
export function allowedHosts(network) {
  if (network === 'none') return [];
  if (Array.isArray(network) && network.length > 0 && network.every(host => typeof host === 'string' && host !== '')) return network;
  return undefined;
}

/** The names of the environment variables any vendor module reads at build time (`buildCredentials`). */
export function buildCredentialNames() {
  const names = new Set();
  for (const { meta } of vendorModules()) {
    if (Array.isArray(meta.buildCredentials)) for (const name of meta.buildCredentials) if (typeof name === 'string') names.add(name);
  }
  return [...names].sort();
}

const MODULES_DIR = join(root, 'packages/modules');

/**
 * Every module built in only on request: the vendor modules, and the project's opt-in modules (`packages/modules/*`
 * whose sharedidEdge block has `"optIn": true`, such as `cmp`; not in the built-in list). Their folders and blocks.
 *
 * @returns {{ folder: string, meta: { export?: unknown, optIn?: unknown } }[]}
 */
export function optInModules() {
  const project = readdirSync(MODULES_DIR, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(join(MODULES_DIR, entry.name, 'package.json')))
    .map(entry => ({ folder: `packages/modules/${entry.name}`, meta: JSON.parse(readFileSync(join(MODULES_DIR, entry.name, 'package.json'), 'utf8')).sharedidEdge ?? {} }))
    .filter(({ meta }) => meta.optIn === true);
  return [...vendorModules(), ...project];
}
