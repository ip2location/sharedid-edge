/* global process */
// Stages the example (../example) for one of this project's Vercel live-test projects (README.md, Live tests), in
// place, before `vercel build`. Not for deployers. live/deploy.sh runs it.
//
//   node live/stage.mjs e2e           # the test page and its Prebid.js bundle (e2e/site/public) in example/public/,
//                                     # served at /, next to the route handler on /_sid/*
//   node live/stage.mjs conformance   # skipTrailingSlashRedirect, so /_sid/sync/ reaches the handler
//   node live/stage.mjs clean         # removes what an earlier staging added
//
// Only example/public/, example/next.config.mjs and example/tsconfig.live.json are written, and none is in the
// repository: the example itself, and what its README documents, stay as they are. A next.config.mjs that this script
// didn't write, or a public/ or tsconfig.live.json it didn't stage, is never touched: staging stops instead.
//
// tsconfig.live.json is the example's tsconfig.json with the repository's tsconfig.base.json, which it extends, folded
// in; next.config.mjs points Next.js at it. `vercel build` run in example/ (a project with no root directory) makes
// example/ Next.js's root (@vercel/next sets NEXT_PRIVATE_OUTPUT_TRACE_ROOT to it), and Turbopack can't read an
// `extends` outside its root: "extends: ../../../../tsconfig.base.json doesn't resolve correctly" (#167). The example
// deployed as its README says (Root Directory set, the whole repository cloned) has the repository as its root, and
// builds as it is.
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const example = join(here, '..', 'example');
const site = join(here, '..', '..', '..', '..', 'e2e', 'site', 'public');
const config = join(example, 'next.config.mjs');
const publicDir = join(example, 'public');
const liveTsconfig = join(example, 'tsconfig.live.json');
const MARKER = '// Staged by packages/adapters/vercel/live/stage.mjs';

const CONFIGS = {
  // The test page at /, as e2e.sharedid.dev serves it: public/index.html, rewritten before the example's own page.
  e2e: `${MARKER} for the Vercel live tests' e2e project; not part of the example.
export default {
  typescript: { tsconfigPath: 'tsconfig.live.json' },
  async rewrites() {
    return { beforeFiles: [{ source: '/', destination: '/index.html' }] };
  }
};
`,
  // The conformance suite's trailing-slash case (/_sid/sync/, which WordPress needs) gets Next.js's 308 by default
  // (README.md, Trailing slashes); with this the handler answers it, as the README describes.
  conformance: `${MARKER} for the Vercel live tests' conformance project; not part of the example.
export default {
  typescript: { tsconfigPath: 'tsconfig.live.json' },
  skipTrailingSlashRedirect: true
};
`
};

const staged = () => existsSync(config) && readFileSync(config, 'utf8').startsWith(MARKER);

function clean() {
  if (!staged()) return;
  rmSync(publicDir, { recursive: true, force: true });
  rmSync(liveTsconfig, { force: true });
  rmSync(config);
}

/** Ends the script with a message on stderr. */
function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

/** A tsconfig.json-style file (comments allowed) as JSON. */
function readTsconfig(file) {
  const { config: json, error } = ts.parseConfigFileTextToJson(file, readFileSync(file, 'utf8'));
  if (error !== undefined) fail(`${file}: ${ts.flattenDiagnosticMessageText(error.messageText, '\n')}`);
  return json;
}

/** The example's tsconfig.json with the file it extends folded in, so nothing in it points outside example/. */
function selfContainedTsconfig() {
  const { extends: base, ...own } = readTsconfig(join(example, 'tsconfig.json'));
  if (base === undefined) return own;
  const inherited = readTsconfig(join(example, base));
  if (inherited.extends !== undefined) fail(`${base} extends another file, which stage.mjs doesn't fold in.`);
  return { ...inherited, ...own, compilerOptions: { ...inherited.compilerOptions, ...own.compilerOptions } };
}

const kind = process.argv[2];
if (kind === 'clean') {
  clean();
} else if (kind === 'e2e' || kind === 'conformance') {
  const others = readdirSync(example).filter(name => /^next\.config\./.test(name) || name === 'public' || name === 'tsconfig.live.json');
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
  writeFileSync(liveTsconfig, `${JSON.stringify(selfContainedTsconfig(), null, 2)}\n`);
  writeFileSync(config, CONFIGS[kind]);
  process.stdout.write(`example/: staged for ${kind}\n`);
} else {
  fail('Usage: node live/stage.mjs e2e|conformance|clean', 2);
}
