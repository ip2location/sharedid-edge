/* global process */
// Stages the example (../example) for one of this project's Vercel live-test projects (README.md, Live tests), in
// place, before `vercel build`. Not for deployers. live/deploy.sh runs it.
//
//   node live/stage.mjs e2e           # the test page and its Prebid.js bundle (e2e/site/public) in example/public/,
//                                     # served at /, next to the route handler on /_sid/*
//   node live/stage.mjs conformance   # skipTrailingSlashRedirect, so /_sid/sync/ reaches the handler
//   node live/stage.mjs clean         # removes what an earlier staging added
//
// Only example/public/ and example/next.config.mjs are written, and neither is in the repository: the example itself,
// and what its README documents, stay as they are. A next.config.mjs that this script didn't write, or a public/ it
// didn't stage, is never touched: staging stops instead.
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const example = join(here, '..', 'example');
const site = join(here, '..', '..', '..', '..', 'e2e', 'site', 'public');
const config = join(example, 'next.config.mjs');
const publicDir = join(example, 'public');
const MARKER = '// Staged by packages/adapters/vercel/live/stage.mjs';

const CONFIGS = {
  // The test page at /, as e2e.sharedid.dev serves it: public/index.html, rewritten before the example's own page.
  e2e: `${MARKER} for the Vercel live tests' e2e project; not part of the example.
export default {
  async rewrites() {
    return { beforeFiles: [{ source: '/', destination: '/index.html' }] };
  }
};
`,
  // The conformance suite's trailing-slash case (/_sid/sync/, which WordPress needs) gets Next.js's 308 by default
  // (README.md, Trailing slashes); with this the handler answers it, as the README describes.
  conformance: `${MARKER} for the Vercel live tests' conformance project; not part of the example.
export default {
  skipTrailingSlashRedirect: true
};
`
};

const staged = () => existsSync(config) && readFileSync(config, 'utf8').startsWith(MARKER);

function clean() {
  if (!staged()) return;
  rmSync(publicDir, { recursive: true, force: true });
  rmSync(config);
}

/** Ends the script with a message on stderr. */
function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

const kind = process.argv[2];
if (kind === 'clean') {
  clean();
} else if (kind === 'e2e' || kind === 'conformance') {
  const others = readdirSync(example).filter(name => /^next\.config\./.test(name) || name === 'public');
  if (others.length > 0 && !staged()) {
    fail(`${example} already has ${others.join(' and ')}, which stage.mjs didn't write. Move them away first.`);
  }
  clean();
  if (kind === 'e2e') {
    if (!existsSync(join(site, 'prebid', 'prebid.js'))) {
      fail('e2e/site/public/prebid/prebid.js is missing: run `npm ci --prefix e2e && npm run bundle-prebid --prefix e2e` first.');
    }
    cpSync(site, publicDir, { recursive: true });
  }
  writeFileSync(config, CONFIGS[kind]);
  process.stdout.write(`example/: staged for ${kind}\n`);
} else {
  fail('Usage: node live/stage.mjs e2e|conformance|clean', 2);
}
