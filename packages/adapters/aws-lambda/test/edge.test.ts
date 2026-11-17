import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigError, resolveConfig } from '@sharedid-edge/core';
import { builtInModules, createEdgeHandler, edgeHandlerFromBuild, edgeHandlerFromText, edgeOptions, edgePlatformInfo, type CloudFrontResultResponse } from '../src/edge.js';
import { edgeEvent } from './edge-events.js';

const UUID = 'c29cb2ae-769d-42f6-891a-f53cadee823d';
const SETTINGS = { SID_COOKIE_DOMAIN: 'example.com' };

interface Payload {
  readonly sharedid?: string;
  readonly ortb2?: { readonly device?: { readonly ip?: string; readonly ipv6?: string; readonly geo?: { readonly country?: string } } };
  readonly ext: { readonly modules: Readonly<Record<string, { readonly status: string }>> };
}

function payload(response: CloudFrontResultResponse): Payload {
  expect(response.bodyEncoding).toBe('text');
  return JSON.parse(response.body) as Payload;
}

function header(response: CloudFrontResultResponse, name: string): string[] {
  return (response.headers[name] ?? []).map(entry => entry.value);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createEdgeHandler (origin-request)', () => {
  it('answers a first-visit sync with a base64 GIF and one set-cookie entry per cookie', async () => {
    const handler = createEdgeHandler({ config: resolveConfig({}) });
    const response = await handler(edgeEvent({ querystring: `id=pubcid%253A${UUID}` }));
    expect(response.status).toBe('200');
    expect(header(response, 'content-type')).toEqual(['image/gif']);
    const cookies = response.headers['set-cookie'] ?? [];
    expect(cookies).toHaveLength(2);
    expect(cookies.every(entry => entry.key === 'Set-Cookie')).toBe(true);
    expect(cookies[0]?.value).toMatch(new RegExp(`^_pubcid=${UUID};`));
    expect(cookies[1]?.value).toMatch(new RegExp(`^_pubcid_sv=${UUID};.*HttpOnly`));
    // CloudFront-Forwarded-Proto is https, so the cookies are Secure.
    for (const entry of cookies) expect(entry.value).toContain('; Secure');
    expect(response.bodyEncoding).toBe('base64');
    const gif = Buffer.from(response.body, 'base64');
    expect(gif.byteLength).toBe(43);
    expect(gif.subarray(0, 6).toString('latin1')).toBe('GIF89a');
  });

  it('keys each header by its lowercase name, with no header CloudFront refuses in a generated response', async () => {
    const response = await createEdgeHandler({ config: resolveConfig({}) })(edgeEvent({ uri: '/_sid/v1' }));
    for (const [name, entries] of Object.entries(response.headers)) {
      expect(name).toBe(name.toLowerCase());
      for (const entry of entries) expect(entry.key.toLowerCase()).toBe(name);
    }
    expect(Object.keys(response.headers)).not.toContain('content-length');
    expect(Object.keys(response.headers)).not.toContain('transfer-encoding');
  });

  it('joins repeated Cookie headers, as CloudFront may pass them, and reads the ID from them', async () => {
    const handler = createEdgeHandler({ config: resolveConfig({}) });
    const response = await handler(edgeEvent({ uri: '/_sid/v1', headers: [['Cookie', 'other=1'], ['Cookie', `_pubcid=${UUID}; _pubcid_sv=${UUID}`]] }));
    expect(response.status).toBe('200');
    expect(header(response, 'x-sharedid-source')).toEqual(['cookie']);
    expect(payload(response).sharedid).toBe(UUID);
  });

  it('builds the URL from the viewer Host and the query string as sent', async () => {
    const handler = createEdgeHandler({ config: resolveConfig({ SID_ALLOWED_ORIGINS: 'https://www.example.com' }) });
    const response = await handler(edgeEvent({ uri: '/_sid/v1', headers: [['Origin', 'https://www.example.com']] }));
    expect(header(response, 'access-control-allow-origin')).toEqual(['https://www.example.com']);
    const sync = await handler(edgeEvent({ querystring: `id=pubcid%253A${UUID}` }));
    expect((sync.headers['set-cookie'] ?? [])[0]?.value).toMatch(new RegExp(`^_pubcid=${UUID};`));
  });

  it('builds an http URL when CloudFront-Forwarded-Proto says http, so cookies lose Secure only on a local host', async () => {
    const handler = createEdgeHandler({ config: resolveConfig({}) });
    const local = await handler(edgeEvent({ omitHeaders: ['host', 'cloudfront-forwarded-proto'], headers: [['Host', '127.0.0.1:8787'], ['CloudFront-Forwarded-Proto', 'http']] }));
    for (const entry of local.headers['set-cookie'] ?? []) expect(entry.value).not.toContain('Secure');
  });

  it('answers HEAD with the headers and cookies and an empty body', async () => {
    const response = await createEdgeHandler({ config: resolveConfig({}) })(edgeEvent({ method: 'HEAD' }));
    expect(response.status).toBe('200');
    expect(response.headers['set-cookie']).toHaveLength(2);
    expect(response.body).toBe('');
    expect(response.bodyEncoding).toBe('text');
  });

  it('answers other methods with 405 without reading a body', async () => {
    const response = await createEdgeHandler({ config: resolveConfig({}) })(edgeEvent({ method: 'POST' }));
    expect(response.status).toBe('405');
  });

  it('takes the client IP from clientIp (IPv4 and IPv6), never from a forged X-Forwarded-For', async () => {
    const handler = createEdgeHandler({ config: resolveConfig({ SID_MODULES: 'ip' }), modules: builtInModules });
    const v4 = payload(await handler(edgeEvent({ uri: '/_sid/v1', headers: [['X-Forwarded-For', '192.0.2.99']] })));
    expect(v4.ortb2?.device?.ip).toBe('198.51.100.23');
    const v6 = payload(await handler(edgeEvent({ uri: '/_sid/v1', clientIp: '2001:db8::1' })));
    expect(v6.ortb2?.device?.ipv6).toBe('2001:db8::1');
  });

  it('maps the viewer location headers to PlatformInfo, as the regional function does', () => {
    const request = edgeEvent().Records[0]?.cf.request;
    expect(request).toBeDefined();
    if (request === undefined) return;
    expect(edgePlatformInfo(request)).toEqual({ clientIp: '198.51.100.23', country: 'US', region: 'WA', city: 'Seattle', timezone: 'America/Los_Angeles', isEU: false });
  });

  it('decides GDPR from the viewer country: a visitor in Germany without a TC string gets no ID', async () => {
    const handler = createEdgeHandler({ config: resolveConfig({}) });
    const response = await handler(edgeEvent({ omitHeaders: ['cloudfront-viewer-country'], headers: [['CloudFront-Viewer-Country', 'DE']] }));
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(header(response, 'x-sharedid-status')[0]).toBe('denied: tcf: GDPR applies and there is no TC string');
  });

  it('without a country header, treats the visitor as one GDPR covers (the default) or leaves it to the client', async () => {
    const event = edgeEvent({ querystring: `id=pubcid%253A${UUID}`, omitHeaders: ['cloudfront-viewer-country'] });
    const failClosed = await createEdgeHandler({ config: resolveConfig({}) })(event);
    expect(failClosed.headers['set-cookie']).toBeUndefined();
    expect(header(failClosed, 'x-sharedid-status')[0]).toBe('denied: tcf: GDPR applies and there is no TC string');
    const client = await createEdgeHandler({ config: resolveConfig({}), gdprWithoutLocation: 'client' })(event);
    expect(client.headers['set-cookie']).toHaveLength(2);
    // gdpr=0 from the page still says GDPR doesn't apply.
    const optedOut = await createEdgeHandler({ config: resolveConfig({}) })(edgeEvent({ querystring: `gdpr=0&id=pubcid%253A${UUID}`, omitHeaders: ['cloudfront-viewer-country'] }));
    expect(optedOut.headers['set-cookie']).toHaveLength(2);
  });

  it('answers a 500, logging no request data, when it is associated with another event', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await createEdgeHandler({ config: resolveConfig({}) })(edgeEvent({ eventType: 'viewer-request' }));
    expect(response.status).toBe('500');
    expect(response.body).toBe('SharedID Edge is misconfigured');
    expect(error.mock.calls.flat().join(' ')).not.toContain('198.51.100.23');
  });

  it('answers a generic 500 to something that is not a CloudFront event', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await createEdgeHandler({ config: resolveConfig({}) })({ Records: [] });
    expect(response).toMatchObject({ status: '500', body: 'Internal error' });
  });
});

describe('createEdgeHandler (viewer-request)', () => {
  it('ignores CloudFront-Viewer-* headers, which a viewer can send itself before CloudFront adds its own', () => {
    const request = edgeEvent({ eventType: 'viewer-request', headers: [['CloudFront-Viewer-Country', 'US'], ['CloudFront-Viewer-Address', '192.0.2.1:1']] }).Records[0]?.cf.request;
    expect(request).toBeDefined();
    if (request === undefined) return;
    expect(edgePlatformInfo(request, { eventType: 'viewer-request' })).toEqual({ clientIp: '198.51.100.23', isEU: true });
    expect(edgePlatformInfo(request, { eventType: 'viewer-request', gdprWithoutLocation: 'client' })).toEqual({ clientIp: '198.51.100.23' });
  });

  it('fails closed by default: no ID without a TC string, and the TC string decides when there is one', async () => {
    const handler = createEdgeHandler({ config: resolveConfig({}), eventType: 'viewer-request' });
    const none = await handler(edgeEvent({ eventType: 'viewer-request', querystring: `id=pubcid%253A${UUID}` }));
    expect(none.status).toBe('200');
    expect(none.headers['set-cookie']).toBeUndefined();
    expect(header(none, 'x-sharedid-status')[0]).toBe('denied: tcf: GDPR applies and there is no TC string');
    const notGdpr = await handler(edgeEvent({ eventType: 'viewer-request', querystring: `gdpr=0&id=pubcid%253A${UUID}` }));
    expect(notGdpr.headers['set-cookie']).toHaveLength(2);
  });

  it('with gdprWithoutLocation client, sets the ID unless the request says GDPR applies', async () => {
    const handler = createEdgeHandler({ config: resolveConfig({}), eventType: 'viewer-request', gdprWithoutLocation: 'client' });
    const set = await handler(edgeEvent({ eventType: 'viewer-request', querystring: `id=pubcid%253A${UUID}` }));
    expect(set.headers['set-cookie']).toHaveLength(2);
    const gdpr = await handler(edgeEvent({ eventType: 'viewer-request', querystring: `gdpr=1&id=pubcid%253A${UUID}` }));
    expect(gdpr.headers['set-cookie']).toBeUndefined();
  });
});

describe('edgeOptions and the baked build', () => {
  it('validates the settings as a deployment does: SID_COOKIE_DOMAIN is required', () => {
    expect(() => edgeOptions({ settings: {} })).toThrow(ConfigError);
    expect(edgeOptions({ settings: SETTINGS })).toMatchObject({ eventType: 'origin-request', gdprWithoutLocation: 'applies' });
  });

  it('refuses trusted-upstream mode, which Lambda@Edge does not have yet', () => {
    expect(() => edgeOptions({ settings: { ...SETTINGS, SID_UPSTREAM_SECRETS: '["0123456789abcdef0123456789abcdef"]' } })).toThrow(/trusted-upstream/);
    expect(() => edgeOptions({ settings: { ...SETTINGS, SID_CLIENT_IP_HEADER: 'x-sid-client-ip' } })).toThrow(/trusted-upstream/);
  });

  it('refuses the geo module on viewer-request, for the deployment and for each host', () => {
    expect(() => edgeOptions({ settings: { ...SETTINGS, SID_MODULES: 'ip,geo' }, eventType: 'viewer-request' })).toThrow(/geo needs the visitor's location/);
    expect(() => edgeOptions({ settings: { ...SETTINGS, SID_HOSTS: '{"www.example.com":{"SID_COOKIE_DOMAIN":"example.com","SID_MODULES":"geo"}}' }, eventType: 'viewer-request' })).toThrow(/SID_HOSTS\["www.example.com"\]: SID_MODULES: geo/);
    expect(edgeOptions({ settings: { ...SETTINGS, SID_MODULES: 'ip,geo' }, eventType: 'origin-request' }).eventType).toBe('origin-request');
  });

  it('refuses an unknown event type or GDPR setting', () => {
    // @ts-expect-error: an invalid event type, as a hand-written build could have
    expect(() => edgeOptions({ settings: SETTINGS, eventType: 'viewer-response' })).toThrow(/event type/);
    // @ts-expect-error: an invalid setting, as a hand-written build could have
    expect(() => edgeOptions({ settings: SETTINGS, gdprWithoutLocation: 'never' })).toThrow(/GDPR without a location/);
  });

  it('gives a 500 handler for invalid settings, or a bundle built without any', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect((await edgeHandlerFromBuild({ settings: {} })(edgeEvent())).status).toBe('500');
    expect((await edgeHandlerFromText(undefined)(edgeEvent())).body).toBe('SharedID Edge is misconfigured');
    expect((await edgeHandlerFromText('{"settings":{"SID_COOKIE_DOMAIN":1}}')(edgeEvent())).status).toBe('500');
  });

  it('runs a baked build: the settings, the event and the GDPR choice', async () => {
    const handler = edgeHandlerFromText(JSON.stringify({ settings: { ...SETTINGS, SID_COOKIE_NAME: 'sid' }, eventType: 'viewer-request', gdprWithoutLocation: 'client' }));
    const response = await handler(edgeEvent({ eventType: 'viewer-request', querystring: `id=pubcid%253A${UUID}` }));
    expect((response.headers['set-cookie'] ?? [])[0]?.value).toMatch(new RegExp(`^sid=${UUID};.*Domain=example.com`, 'i'));
  });
});
