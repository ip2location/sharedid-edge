import { Buffer } from 'node:buffer';

/** A response body as Lambda returns it: a string, and whether it's base64. */
export interface EncodedBody {
  readonly body: string;
  readonly base64: boolean;
}

/**
 * The body of `response` to `method` as a string: text and JSON as UTF-8, so it's readable in logs and tests; anything
 * else (the sync GIF) as base64. HEAD gets an empty body. Shared by the regional function and Lambda@Edge.
 */
export async function encodeBody(response: Response, method: string): Promise<EncodedBody> {
  const bytes = method === 'HEAD' || response.body === null ? new Uint8Array() : new Uint8Array(await response.arrayBuffer());
  const text = bytes.byteLength === 0 || isText(response.headers.get('content-type'));
  return { body: text ? new TextDecoder().decode(bytes) : Buffer.from(bytes).toString('base64'), base64: !text };
}

function isText(contentType: string | null): boolean {
  if (contentType === null) return false;
  const type = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return type.startsWith('text/') || type === 'application/json' || type.endsWith('+json');
}

/** `value`, or undefined when it's null, undefined or empty. */
export function nonEmpty(value: string | null | undefined): string | undefined {
  return value === null || value === undefined || value === '' ? undefined : value;
}
