import type { CloudFrontRequestEvent } from '../src/edge.js';

/**
 * A Lambda@Edge event as CloudFront delivers it for `GET https://www.example.com/_sid/sync?id=pubcid%3A<id>` from
 * Prebid.js, on a `/_sid/*` behaviour with the managed AllViewerAndCloudFrontHeaders-2022-06 origin request policy:
 * with `origin-request`, the viewer's headers plus CloudFront's (`CloudFront-Viewer-*`, `CloudFront-Forwarded-Proto`),
 * and with `viewer-request`, the viewer's headers alone. Shaped after the examples in AWS's
 * [Lambda@Edge event structure](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/lambda-event-structure.html);
 * the values are documentation addresses and made-up IDs.
 */
export function edgeEvent(overrides: {
  /** The event, or another CloudFront event type (`viewer-response`, say) for a function associated with the wrong one. */
  readonly eventType?: string;
  readonly uri?: string;
  readonly querystring?: string;
  readonly method?: string;
  readonly clientIp?: string;
  /** Extra headers, `[name as sent, value]`, after the defaults: repeated names are kept as separate values. */
  readonly headers?: readonly (readonly [string, string])[];
  /** Default headers to leave out, by lowercase name. */
  readonly omitHeaders?: readonly string[];
} = {}): CloudFrontRequestEvent {
  const eventType = overrides.eventType ?? 'origin-request';
  const clientIp = overrides.clientIp ?? '198.51.100.23';
  const viewer: [string, string][] = [
    ['Host', 'www.example.com'],
    ['User-Agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'],
    ['Accept', 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'],
    ['Accept-Language', 'en-US,en;q=0.9'],
    ['Referer', 'https://www.example.com/article']
  ];
  const cloudFront: [string, string][] = eventType === 'origin-request'
    ? [
        ['X-Forwarded-For', clientIp],
        ['Via', '2.0 0123456789abcdef0123456789abcdef.cloudfront.net (CloudFront)'],
        ['CloudFront-Forwarded-Proto', 'https'],
        ['CloudFront-Viewer-Address', clientIp.includes(':') ? `[${clientIp}]:51234` : `${clientIp}:51234`],
        ['CloudFront-Viewer-Country', 'US'],
        ['CloudFront-Viewer-Country-Region', 'WA'],
        ['CloudFront-Viewer-City', 'Seattle'],
        ['CloudFront-Viewer-Time-Zone', 'America/Los_Angeles']
      ]
    : [];
  const headers: Record<string, { key: string; value: string }[]> = {};
  const defaults = [...viewer, ...cloudFront].filter(([key]) => !(overrides.omitHeaders ?? []).includes(key.toLowerCase()));
  for (const [key, value] of [...defaults, ...overrides.headers ?? []]) (headers[key.toLowerCase()] ??= []).push({ key, value });
  return {
    Records: [{
      cf: {
        config: {
          distributionDomainName: 'd111111abcdef8.cloudfront.net',
          eventType,
          // Fields the adapter doesn't read, as CloudFront sends them.
          ...{ distributionId: 'EDFDVBD6EXAMPLE', requestId: '4TyzHTaYWb1GX1qTfsHhEqV6HUDd_BzoBZnwfnvQc_1oF26ClkoUSEQ==' }
        },
        request: {
          clientIp,
          method: overrides.method ?? 'GET',
          uri: overrides.uri ?? '/_sid/sync',
          querystring: overrides.querystring ?? '',
          headers
        }
      }
    }]
  };
}
