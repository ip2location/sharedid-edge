import { ConfigError, handlerOrMisconfigured, publicOriginFromEnv, refuseTrustedUpstream, settingsFromEnv, type EdgeModule } from '@sharedid-edge/core';
import { builtInModules } from '@sharedid-edge/modules';
import { createEdgeHandler, edgeInternalError, type EdgeEventType, type EdgeHandler, type EdgeHandlerOptions, type GdprWithoutLocation } from './edge-handler.js';

/**
 * What a Lambda@Edge build bakes into the bundle, since Lambda@Edge has no environment variables: the `SID_*`
 * settings (`SID_MODULE_CONFIG` and the like as JSON strings, as in an environment), the event the function will be
 * associated with, and whether GDPR applies to a visitor whose country isn't known.
 */
export interface EdgeBuild {
  readonly settings: Readonly<Record<string, string>>;
  readonly eventType?: EdgeEventType;
  readonly gdprWithoutLocation?: GdprWithoutLocation;
}

const EVENT_TYPES: readonly string[] = ['origin-request', 'viewer-request'] satisfies readonly EdgeEventType[];
const GDPR_WITHOUT_LOCATION: readonly string[] = ['applies', 'client'] satisfies readonly GdprWithoutLocation[];

/** Modules that need the visitor's location, which a viewer-request function never has. */
const NEEDS_LOCATION: readonly string[] = ['geo'];

/**
 * The handler options for a build, validated as the deployment needs them: the settings as `settingsFromEnv` reads
 * them (`SID_COOKIE_DOMAIN` required), with trusted-upstream mode refused (not available on Lambda@Edge yet), and
 * modules that need a location refused with `viewer-request`, which has none. The bundle script runs this when it
 * builds, and fails the build on a `ConfigError`; the bundle runs it again at start-up.
 *
 * @throws ConfigError naming the setting at fault
 */
export function edgeOptions(build: EdgeBuild, modules: readonly EdgeModule[] = builtInModules): EdgeHandlerOptions {
  const eventType = build.eventType ?? 'origin-request';
  if (!EVENT_TYPES.includes(eventType)) throw new ConfigError(`event type: use ${EVENT_TYPES.join(' or ')}, not ${eventType}`);
  const gdprWithoutLocation = build.gdprWithoutLocation ?? 'applies';
  if (!GDPR_WITHOUT_LOCATION.includes(gdprWithoutLocation)) throw new ConfigError(`GDPR without a location: use ${GDPR_WITHOUT_LOCATION.join(' or ')}, not ${gdprWithoutLocation}`);
  for (const name of ['SID_CLIENT_IP_HEADER', 'SID_LOCATION_HEADERS']) {
    if ((build.settings[name] ?? '') !== '') throw new ConfigError(`${name}: trusted-upstream mode isn't available on Lambda@Edge`);
  }
  const settings = settingsFromEnv(refuseTrustedUpstream(build.settings), { requireCookieDomain: true });
  if (eventType === 'viewer-request') {
    for (const [where, config] of [['', settings.config] as const, ...[...settings.hosts ?? []].map(([host, config]) => [`SID_HOSTS["${host}"]: `, config] as const)]) {
      const needs = config.modules.filter(name => NEEDS_LOCATION.includes(name));
      if (needs.length > 0) throw new ConfigError(`${where}SID_MODULES: ${needs.join(', ')} needs the visitor's location, which a viewer-request function doesn't have; build for origin-request`);
    }
  }
  return { ...settings, modules, eventType, gdprWithoutLocation, ...publicOriginFromEnv(build.settings) };
}

/**
 * The handler for a build, once per cold start. Invalid settings give a handler that answers every request with a 500,
 * like the other adapters, rather than one that sets wrong cookies; the reason is logged to CloudWatch, in the region
 * of the edge location that ran it.
 */
export function edgeHandlerFromBuild(build: EdgeBuild, modules: readonly EdgeModule[] = builtInModules): EdgeHandler {
  return handlerOrMisconfigured(
    () => createEdgeHandler(edgeOptions(build, modules)),
    () => () => Promise.resolve(edgeInternalError('SharedID Edge is misconfigured'))
  );
}

/**
 * Reads a build from its JSON text (what the bundle script bakes in), checking its shape. Anything else, including
 * nothing (a bundle built without settings), is a `ConfigError`.
 */
export function parseEdgeBuild(text: unknown): EdgeBuild {
  let value: unknown;
  try {
    value = typeof text === 'string' ? JSON.parse(text) : undefined;
  } catch {
    value = undefined;
  }
  if (typeof value !== 'object' || value === null) throw new ConfigError('the bundle has no settings; build it with --config');
  const settings: unknown = Reflect.get(value, 'settings');
  if (typeof settings !== 'object' || settings === null || Object.values(settings).some(v => typeof v !== 'string')) {
    throw new ConfigError('the bundle\'s settings must be strings');
  }
  const eventType: unknown = Reflect.get(value, 'eventType');
  const gdprWithoutLocation: unknown = Reflect.get(value, 'gdprWithoutLocation');
  return {
    // Checked above: an object of strings.
    settings: settings as Record<string, string>,
    // Checked by edgeOptions, which names the setting.
    ...(typeof eventType === 'string' ? { eventType: eventType as EdgeEventType } : {}),
    ...(typeof gdprWithoutLocation === 'string' ? { gdprWithoutLocation: gdprWithoutLocation as GdprWithoutLocation } : {})
  };
}

/** The handler for a build's JSON text: `parseEdgeBuild`, then `edgeHandlerFromBuild`, with any `ConfigError` a 500. */
export function edgeHandlerFromText(text: unknown, modules: readonly EdgeModule[] = builtInModules): EdgeHandler {
  return handlerOrMisconfigured(
    () => edgeHandlerFromBuild(parseEdgeBuild(text), modules),
    () => () => Promise.resolve(edgeInternalError('SharedID Edge is misconfigured'))
  );
}
