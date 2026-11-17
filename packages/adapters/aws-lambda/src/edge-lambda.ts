// The deployed Lambda@Edge entry point (bundled to deploy-edge/edge.mjs by scripts/bundle-edge.mjs; the function's
// handler is `edge.handler`). Lambda@Edge has no environment variables, so the build bakes the settings in as
// `globalThis.__SID_EDGE__`, a JSON string it validated first. A bundle built with --unbaked (for the conformance
// suite's stand-in only) leaves the expression as is, and reads what the stand-in set before loading it.
import type { EdgeHandler } from './edge-handler.js';
import { edgeHandlerFromText } from './edge-env.js';

export const handler: EdgeHandler = edgeHandlerFromText((globalThis as { __SID_EDGE__?: string }).__SID_EDGE__);
