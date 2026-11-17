import { ConfigError, parseIp, type RateLimiter } from '@sharedid-edge/core';

/**
 * The Workers rate limiting binding counting requests per visitor: keyed by the client IP address (an IPv6 address by
 * its /64, which one visitor usually holds whole). In trusted-upstream mode, that's the forwarded address.
 */
export const CLIENT_BINDING = 'SID_RATE_LIMIT_CLIENT';
/** The Workers rate limiting binding counting requests per site: keyed by the site's hostname. */
export const HOST_BINDING = 'SID_RATE_LIMIT_HOST';

/** A Workers rate limiting binding: `limit({ key })` resolves to `{ success }`. */
interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** The binding `name` in `env`, undefined when it isn't bound. Throws a `ConfigError` when it's something else, a var say. */
function binding(env: Readonly<Record<string, unknown>>, name: string): RateLimitBinding | undefined {
  const value = env[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || typeof (value as { limit?: unknown }).limit !== 'function') {
    throw new ConfigError(`${name} must be a rate limiting binding ("ratelimits" in wrangler.jsonc), not a variable`);
  }
  // Checked above: an object with a limit function, as the runtime gives a rate limiting binding.
  return value as RateLimitBinding;
}

/** The key for a client IP: an IPv4 address as it is, an IPv6 address by its /64. Undefined without a valid address. */
export function clientKey(clientIp: string | undefined): string | undefined {
  const parsed = clientIp === undefined ? undefined : parseIp(clientIp);
  if (parsed === undefined) return undefined;
  return parsed.version === 4 ? parsed.octets.join('.') : `${parsed.hextets.slice(0, 4).map(h => h.toString(16)).join(':')}::/64`;
}

/**
 * The handler's `rateLimit` option from the Worker's rate limiting bindings, `SID_RATE_LIMIT_CLIENT` and
 * `SID_RATE_LIMIT_HOST`; `{}` when neither is bound. A request is refused when either binding's limit is reached. A
 * request without a client IP is counted only per site. The counts are Cloudflare's, per location and approximate; the
 * Worker keeps nothing.
 *
 * @throws ConfigError when one of the names is bound to something else.
 */
export function rateLimitFromEnv(env: Readonly<Record<string, unknown>>): { readonly rateLimit?: RateLimiter } {
  const client = binding(env, CLIENT_BINDING);
  const host = binding(env, HOST_BINDING);
  if (client === undefined && host === undefined) return {};
  return {
    rateLimit: async request => {
      const key = clientKey(request.clientIp);
      const outcomes = await Promise.all([
        ...(host === undefined ? [] : [host.limit({ key: request.host })]),
        ...(client === undefined || key === undefined ? [] : [client.limit({ key })])
      ]);
      return outcomes.every(outcome => outcome.success);
    }
  };
}
