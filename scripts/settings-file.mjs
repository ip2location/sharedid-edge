// Reads a JSON file of SID_* settings for a build that bakes them in, for the platforms with no environment variables:
// the Cloudflare Snippet (packages/adapters/cloudflare/scripts/build-snippet.mjs) and Lambda@Edge
// (packages/adapters/aws-lambda/scripts/bundle-edge.mjs). The file is a JSON object of SID_* settings, as a
// deployment's environment variables; a value may be a JSON object or array (SID_MODULE_CONFIG, say), which becomes its
// JSON text, and keys starting with `$` ("$comment") are skipped.
import { existsSync, readFileSync } from 'node:fs';

/** A settings file that can't be used; its message says why, naming the file but never a value. */
export class SettingsFileError extends Error {
  name = 'SettingsFileError';
}

/**
 * The settings in `file`, as an environment: every value a string. `missing` is the message for a file that doesn't
 * exist; `refuse(key)` returns why a setting can't be baked into this build (a secret, say), or undefined to accept it.
 *
 * @param {string} file
 * @param {{ shown: string, missing: string, what: string, refuse?: (key: string) => string | undefined }} options `shown`:
 *   the file as messages name it; `what`: the configuration, as in "only SID_* settings go in <what>"
 * @returns {Record<string, string>}
 * @throws {SettingsFileError}
 */
export function readSettingsFile(file, { shown, missing, what, refuse = () => undefined }) {
  if (!existsSync(file)) throw new SettingsFileError(missing);
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new SettingsFileError(`${shown} isn't valid JSON (${error.message}).`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SettingsFileError(`${shown} must be a JSON object of SID_* settings.`);
  /** @type {Record<string, string>} */
  const env = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith('$')) continue;
    const refused = key.startsWith('SID_') ? refuse(key) : `${key}: only SID_* settings go in ${what}.`;
    if (refused !== undefined) throw new SettingsFileError(refused);
    env[key] = typeof value === 'string' ? value : JSON.stringify(value);
  }
  return env;
}
