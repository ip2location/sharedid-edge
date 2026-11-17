import { createHandler, logRequestFailure, parseIp, splitHeaders, type HandlerOptions, type PlatformInfo } from '@sharedid-edge/core';
import { encodeBody, nonEmpty } from './body.js';
import type { CloudFrontHeaders, CloudFrontRequest, CloudFrontRequestEvent, CloudFrontResultResponse } from './edge-event.js';
import { viewerInfo } from './platform.js';

/**
 * The CloudFront event a Lambda@Edge function is associated with. `origin-request` runs at CloudFront's regional edge
 * caches and sees the `CloudFront-Viewer-*` location headers the behaviour's origin request policy adds, so GDPR can
 * follow from the visitor's country and the `geo` module works. `viewer-request` runs at every edge location, closer
 * to the visitor, but CloudFront adds those headers only after it: there is no location.
 */
export type EdgeEventType = 'origin-request' | 'viewer-request';

/**
 * Whether GDPR applies to a visitor whose country isn't known: always with `viewer-request`, and with
 * `origin-request` when CloudFront sends no `CloudFront-Viewer-Country` (the origin request policy doesn't forward
 * it, or the address can't be located). `applies` (the default): it does, so without a TC string (the CMP's
 * `euconsent-v2` cookie or `gdpr_consent`) or `gdpr=0` nothing is set, as for a visitor in the EU. `client`: only
 * when the request says so, with a TC string or `gdpr=1`, as on the other platforms without a location; choose it
 * only when the page's CMP writes the TC string for every visitor GDPR covers before Prebid.js calls `/sync`.
 */
export type GdprWithoutLocation = 'applies' | 'client';

export interface EdgeHandlerOptions extends HandlerOptions {
  /** The event the function is associated with; default `origin-request`. A request from another event gets a 500. */
  readonly eventType?: EdgeEventType;
  /** Whether GDPR applies to a visitor whose country isn't known (default `applies`); see `GdprWithoutLocation`. */
  readonly gdprWithoutLocation?: GdprWithoutLocation;
  /**
   * Origin used to build request URLs, e.g. `https://www.example.com`. Defaults to the scheme of
   * `CloudFront-Forwarded-Proto` (https unless it says http) and the viewer's `Host`, which reach the function
   * unchanged: the generated response never goes to an origin, so nothing rewrites them.
   */
  readonly publicOrigin?: string;
}

/** A Lambda@Edge handler for origin-request or viewer-request events that generates the response itself. */
export type EdgeHandler = (event: CloudFrontRequestEvent) => Promise<CloudFrontResultResponse>;

/**
 * Builds a Lambda@Edge handler around the core SharedID Edge handler: the CloudFront request becomes a `Request`, and
 * the `Response` a generated response, so CloudFront answers the viewer without contacting the behaviour's origin.
 */
export function createEdgeHandler(options: EdgeHandlerOptions = {}): EdgeHandler {
  const handler = createHandler(options);
  const eventType = options.eventType ?? 'origin-request';
  return async event => {
    try {
      const cf = event.Records[0]?.cf;
      if (cf === undefined) throw new TypeError('not a CloudFront event');
      // A function built for one event and associated with the other would read headers that aren't CloudFront's
      // (a viewer can send CloudFront-Viewer-* to a viewer-request function), or none at all: refuse, don't guess.
      if (cf.config.eventType !== undefined && cf.config.eventType !== eventType) {
        console.error(`sharedid-edge: built for ${eventType} and associated with ${cf.config.eventType}; rebuild with --event-type ${cf.config.eventType}`);
        return edgeInternalError('SharedID Edge is misconfigured');
      }
      const request = toRequest(cf.request, cf.config.distributionDomainName, options.publicOrigin);
      return await toResult(await handler(request, edgePlatformInfo(cf.request, options)), request.method);
    } catch (error) {
      logRequestFailure(error);
      return edgeInternalError('Internal error');
    }
  };
}

/** A generic 500, for failures and configuration errors. Never includes request data. */
export function edgeInternalError(message: string): CloudFrontResultResponse {
  return {
    status: '500',
    headers: {
      'content-type': [{ key: 'Content-Type', value: 'text/plain; charset=utf-8' }],
      'cache-control': [{ key: 'Cache-Control', value: 'no-store' }]
    },
    body: message,
    bodyEncoding: 'text'
  };
}

/** A header's values, trimmed and without blanks. */
function values(headers: CloudFrontHeaders, name: string): string[] {
  return (headers[name] ?? []).map(entry => entry.value.trim()).filter(value => value !== '');
}

/**
 * What the platform knows about the request. The client IP is always `clientIp`, which CloudFront sets from the
 * connection: never `X-Forwarded-For`, which the visitor controls.
 *
 * - `origin-request`: the location from the `CloudFront-Viewer-*` headers, which CloudFront adds after the viewer
 *   request and which replace a visitor's own copies ([Lambda@Edge restrictions](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/lambda-at-edge-function-restrictions.html#lambda-at-edge-restrictions-cloudfront-headers)).
 * - `viewer-request`: no location. Those headers aren't CloudFront's yet (a visitor's own would arrive as sent), so
 *   they're ignored.
 *
 * Without a country, and with `gdprWithoutLocation: 'applies'` (the default), `isEU` is `true`, so core treats the
 * visitor as one GDPR covers, as it would a visitor in the EU: an unknown country never counts as outside the EU.
 */
export function edgePlatformInfo(request: CloudFrontRequest, options: Pick<EdgeHandlerOptions, 'eventType' | 'gdprWithoutLocation'> = {}): PlatformInfo {
  const clientIp = parseIp(request.clientIp) === undefined ? undefined : request.clientIp;
  const info = (options.eventType ?? 'origin-request') === 'origin-request'
    ? viewerInfo(clientIp, name => values(request.headers, name)[0])
    : viewerInfo(clientIp, () => undefined);
  return info.country === undefined && options.gdprWithoutLocation !== 'client' ? { ...info, isEU: true } : info;
}

function toRequest(request: CloudFrontRequest, distributionDomainName: string | undefined, publicOrigin: string | undefined): Request {
  const headers = new Headers();
  for (const name of Object.keys(request.headers)) {
    const all = (request.headers[name] ?? []).map(entry => entry.value);
    if (all.length > 0) headers.set(name, all.join(name === 'cookie' ? '; ' : ', '));
  }
  const host = nonEmpty(values(request.headers, 'host')[0]) ?? nonEmpty(distributionDomainName) ?? 'localhost';
  const scheme = values(request.headers, 'cloudfront-forwarded-proto')[0]?.toLowerCase() === 'http' ? 'http' : 'https';
  const url = new URL(`${request.uri}${request.querystring === '' ? '' : `?${request.querystring}`}`, publicOrigin ?? `${scheme}://${host}`);
  // Without the body: no route reads one (and the association doesn't include it), so nothing is decoded before a 405.
  return new Request(url, { method: request.method.toUpperCase(), headers });
}

/**
 * Headers a function can't set on a generated response: CloudFront answers with a 502 if it does
 * ([restrictions on edge functions](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/edge-function-restrictions-all.html#function-restrictions-headers)).
 * Core sets none of them; they're dropped rather than turned into a 502.
 */
const NOT_ALLOWED = /^(connection|expect|keep-alive|proxy-authenticate|proxy-authorization|proxy-connection|trailer|upgrade|x-accel-.*|x-amz-cf-.*|x-amzn-.*|x-cache|x-edge-.*|x-forwarded-proto|x-real-ip|content-length|transfer-encoding|via)$/;

async function toResult(response: Response, method: string): Promise<CloudFrontResultResponse> {
  const { headers, cookies } = splitHeaders(response.headers);
  const result: Record<string, { key: string; value: string }[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!NOT_ALLOWED.test(name)) result[name] = [{ key: name, value }];
  }
  // One entry per cookie: joined, they'd break.
  if (cookies.length > 0) result['set-cookie'] = cookies.map(value => ({ key: 'Set-Cookie', value }));
  const { body, base64 } = await encodeBody(response, method);
  return {
    status: String(response.status),
    ...(response.statusText === '' ? {} : { statusDescription: response.statusText }),
    headers: result,
    body,
    bodyEncoding: base64 ? 'base64' : 'text'
  };
}
