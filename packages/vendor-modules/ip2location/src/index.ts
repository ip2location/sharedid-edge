import { defineModule, PROXY_KINDS, type EdgeModule, type ModuleContext, type ModuleResult, type ProxyKind, type TrafficReport } from '@sharedid-edge/core';
import { decodeRangeTable, ipDatabaseModule, ipDatabaseSettings, lookupClient, type DataInfo, type RangeTable } from '@sharedid-edge/ip-ranges';
import { DATA, DATA_INFO, PROXY_DATA, PROXY_DATA_INFO } from './data.js';

export { geoMode, type GeoMode } from '@sharedid-edge/ip-ranges';
export { IP2LOCATION_ATTRIBUTION, IP2PROXY_ATTRIBUTION } from './attribution.js';

/** IP2Location's value in AdCOM 1.0's List: IP Location Services, sent as `device.geo.ipservice`. */
export const IP2LOCATION_IPSERVICE = 1;

/**
 * What's built in for the country: the database and its date, or `fixture: true` when `npm run data` hasn't been run,
 * in which case the module only knows the documentation addresses and finds nothing for real visitors.
 */
export const IP2LOCATION_DATA_INFO: DataInfo = DATA_INFO;

/** The same for the proxy signals. */
export const IP2PROXY_DATA_INFO: DataInfo = PROXY_DATA_INFO;

const country = ipDatabaseModule({ name: 'ip2location', data: DATA, info: DATA_INFO, ipservice: IP2LOCATION_IPSERVICE });
const proxyTable: RangeTable = decodeRangeTable(PROXY_DATA);

/** The most specific proxy kind in a table value such as `vpn,public`, or undefined. */
function proxyFor(table: RangeTable, clientIp: string | undefined): ProxyKind | undefined {
  const code = lookupClient(table, clientIp);
  if (code === undefined) return undefined;
  const kinds = code.split(',');
  return PROXY_KINDS.find(kind => kinds.includes(kind));
}

/**
 * The `ip2location` module: the visitor's country from IP2Location LITE DB1, as `ortb2.device.geo.country` (ISO
 * 3166-1 alpha-3, `type` 2, `ipservice` 1), and proxy signals from IP2Proxy LITE PX10, as `ortb2.device.ext.traffic`.
 * Both databases are downloaded with the deployer's free download token and built into the bundle by `npm run data`
 * (scripts/build-data.mjs); the token is used only there and never reaches the bundle. Lookups happen in memory, with
 * no network access, and nothing about the request is stored or logged. `{"mode":"fill"}` (the default) only fills a
 * country the CDN doesn't give the `geo` module; `{"mode":"replace"}` always sends IP2Location's. The traffic signal
 * is sent whichever the mode.
 */
export const ip2locationModule: EdgeModule = defineModule({
  name: 'ip2location',
  async run(context: ModuleContext): Promise<ModuleResult | undefined> {
    const { maxAgeDays } = ipDatabaseSettings('ip2location', context.config);
    const geo = (await country.run(context)) ?? {};
    const proxy = proxyFor(proxyTable, context.platform.clientIp);
    const proxyStale = maxAgeDays !== undefined && Date.now() - Date.parse(PROXY_DATA_INFO.built) > maxAgeDays * 86_400_000;
    const traffic: TrafficReport | undefined = proxy === undefined ? undefined : { proxy };
    if (traffic === undefined && geo.ortb2 === undefined && geo.stale !== true) return undefined;
    return { ...geo, ...(traffic === undefined ? {} : { traffic }), ...(geo.stale === true || proxyStale ? { stale: true } : {}) };
  }
});
