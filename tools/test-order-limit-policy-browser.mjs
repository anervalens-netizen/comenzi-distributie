import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { browserFixture, waitFor } from './offline-browser-fixture.mjs';

const source = `
  import {createRoot} from 'react-dom/client';
  import {OrderLimitPolicy} from './components/order-limit-policy';
  import {setLocalWorkUserId} from './lib/local-work';
  const userId = location.search.includes('regional') ? 'regional' : 'global';
  setLocalWorkUserId(userId);
  createRoot(document.getElementById('root')).render(<OrderLimitPolicy userId={userId}/>);
`;
const bundle = await build({
  stdin: { contents: source, resolveDir: resolve('.'), loader: 'tsx' },
  outdir: 'out',
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'silent',
});
const script = bundle.outputFiles.find((file) =>
  file.path.endsWith('.js'),
).text;
const css = [
  readFileSync('app/globals.css', 'utf8').replace(/^@import[^\n]+\n/gm, ''),
  ...bundle.outputFiles
    .filter((file) => file.path.endsWith('.css'))
    .map((file) => file.text),
].join('\n');

let policy = {
  revision: 0,
  floors: { casesFilms: 5, chargers: 10, cablesAdapters: 10, prepaidSim: 250 },
};
const saves = [];
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://synthetic.invalid').pathname;
  if (pathname === '/fixture.js') {
    response.setHeader('Content-Type', 'text/javascript');
    response.end(script);
    return;
  }
  if (pathname === '/api/order-limit-policy') {
    response.setHeader('Content-Type', 'application/json');
    const manager = request.headers['x-operation-user'];
    const canEdit = manager === 'global';
    if (request.method === 'PUT') {
      if (!canEdit) {
        response.writeHead(403).end(JSON.stringify({ error: 'Forbidden' }));
        return;
      }
      let body = '';
      for await (const bytes of request) body += bytes;
      const requested = JSON.parse(body);
      saves.push(requested);
      if (requested.revision !== policy.revision) {
        response
          .writeHead(409)
          .end(JSON.stringify({ error: 'Revision conflict' }));
        return;
      }
      policy = { revision: policy.revision + 1, floors: requested.floors };
    }
    response.end(JSON.stringify({ ...policy, canEdit }));
    return;
  }
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(
    `<!doctype html><html lang="ro"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><main id="root"></main><script type="module" src="/fixture.js"></script></html>`,
  );
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

let browser;
try {
  const origin = 'http://127.0.0.1:' + server.address().port;
  browser = await browserFixture(origin);
  const textIncludes = (tab, selector, expected) =>
    waitFor(
      () =>
        tab.evaluate(
          `document.querySelector(${JSON.stringify(selector)})?.textContent.includes(${JSON.stringify(expected)})`,
        ),
      expected,
    );
  const fill = (value) =>
    browser.evaluate(`(() => {
    const input = document.querySelector('.order-policy-form input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', {bubbles: true}));
    return true;
  })()`);
  const submit = () =>
    browser.evaluate(
      "document.querySelector('.order-policy-form button[type=submit]').click()",
    );

  await browser.send('Emulation.setDeviceMetricsOverride', {
    width: 800,
    height: 1200,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await textIncludes(browser, '.order-policy-version', 'Versiunea 0');
  assert.deepEqual(
    await browser.evaluate(
      "[...document.querySelectorAll('.order-policy-form input')].map(input=>input.value)",
    ),
    ['5', '10', '10', '250'],
  );
  assert.equal(
    await browser.evaluate(
      "document.querySelector('.order-policy-form button[type=submit]').disabled",
    ),
    true,
  );
  assert.equal(
    await browser.evaluate('document.documentElement.scrollWidth<=innerWidth'),
    true,
  );

  await fill('7');
  await submit();
  await textIncludes(browser, '.order-policy-version', 'Versiunea 1');
  await textIncludes(
    browser,
    '.order-policy-notice',
    'Pragurile au fost salvate',
  );
  assert.deepEqual(saves[0], {
    revision: 0,
    floors: {
      casesFilms: 7,
      chargers: 10,
      cablesAdapters: 10,
      prepaidSim: 250,
    },
  });

  policy = { revision: 2, floors: { ...policy.floors, casesFilms: 8 } };
  await fill('9');
  await submit();
  await textIncludes(
    browser,
    '.order-policy-card [role=alert]',
    'Pragurile s-au schimbat',
  );
  assert.equal(saves[1].revision, 1);
  assert.equal(
    await browser.evaluate(
      "document.querySelector('.order-policy-form button[type=submit]').disabled",
    ),
    true,
  );
  assert.equal(
    policy.floors.casesFilms,
    8,
    'The stale draft cannot overwrite the newer policy',
  );
  await browser.evaluate(
    "document.querySelector('.order-policy-head button').click()",
  );
  await textIncludes(browser, '.order-policy-version', 'Versiunea 2');
  assert.equal(
    await browser.evaluate(
      "document.querySelector('.order-policy-form input').value",
    ),
    '8',
  );

  const regional = await browser.newTab(origin + '/?regional=1');
  await textIncludes(regional, '.order-policy-readonly', '250 buc.');
  assert.equal(
    await regional.evaluate(
      "!!document.querySelector('.order-policy-card input,.order-policy-card button[type=submit]')",
    ),
    false,
  );
  assert.equal(saves.length, 2, 'Regional view does not expose policy updates');
  console.log(
    'PASS: global category floor editing and revisions, conflict/reload, regional read-only and tablet layout.',
  );
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
