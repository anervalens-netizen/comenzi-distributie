import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { browserFixture, waitFor } from './offline-browser-fixture.mjs';

const directory = mkdtempSync(join(tmpdir(), 'leave-browser-'));
const probe = createServer();
await new Promise((done) => probe.listen(0, '127.0.0.1', done));
const port = probe.address().port;
await new Promise((done) => probe.close(done));
const origin = 'http://127.0.0.1:' + port;
const server = spawn(process.execPath, [resolve('dist/standalone/server.js')], {
  env: {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    MOBIUP_DATA_DIR: directory,
    NODE_ENV: 'production',
  },
  stdio: 'ignore',
});
const exited = new Promise((done) => server.once('exit', done));
const agent = 'synthetic-leave-agent';
const manager = 'synthetic-leave-manager';
const secondManager = 'synthetic-leave-manager-second';
const legalName = 'Synthetic Ștefan Test';
const hr = 'hr@example.test';
const cc = 'manager@example.test';
const secondCc = 'manager-second@example.test';
const start = '2026-11-27';
const originalEnd = '2026-12-02';
const end = '2026-12-03';
const filename = 'cerere-concediu-Synthetic-Stefan-Test-2026-11-27.pdf';
let browser;
let db;

function seed() {
  db = new DatabaseSync(join(directory, 'mobiup.sqlite'));
  const tokens = {};
  for (const [id, role, name] of [
    [agent, 'agent', 'Test Agent'],
    [manager, 'manager', 'Test Manager A'],
    [secondManager, 'manager', 'Test Manager B'],
  ]) {
    db.prepare(
      'INSERT INTO users(id,username,name,role,manager_scope,password_hash,must_change_password,active) VALUES(?,?,?,?,?,?,0,1)',
    ).run(id, id, name, role, 'assigned', 'disabled');
    const token = randomUUID();
    tokens[id] = token;
    db.prepare(
      'INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)',
    ).run(
      createHash('sha256').update(token).digest('hex'),
      id,
      Date.now() + 3600000,
    );
  }
  const link = db.prepare(
    'INSERT INTO manager_agents(manager_id,agent_id) VALUES(?,?)',
  );
  link.run(manager, agent);
  link.run(secondManager, agent);
  db.prepare(
    "INSERT INTO settings(key,value) VALUES('leave-mail-to-v1',?)",
  ).run(hr);
  return tokens;
}

async function signOnTablet(tab) {
  const rect = await tab.evaluate(`(() => {
    const svg = document.querySelector('.leave-signature-surface svg');
    svg.scrollIntoView({ block: 'center' });
    return svg.getBoundingClientRect().toJSON();
  })()`);
  const touch = (type, x, y) =>
    tab.send('Input.dispatchTouchEvent', {
      type,
      touchPoints:
        type === 'touchEnd'
          ? []
          : [{ x: rect.left + x * rect.width, y: rect.top + y * rect.height }],
    });
  await touch('touchStart', 0.12, 0.66);
  for (const [x, y] of [
    [0.18, 0.3],
    [0.24, 0.2],
    [0.31, 0.6],
    [0.38, 0.65],
    [0.49, 0.3],
    [0.55, 0.55],
    [0.7, 0.37],
  ]) {
    await touch('touchMove', x, y);
  }
  await touch('touchEnd');
}

const matching = (scope, label) =>
  `[...document.querySelectorAll(${JSON.stringify(scope)})].find(el => el.textContent.trim() === ${JSON.stringify(label)} && el.getClientRects().length)`;
async function click(tab, scope, text) {
  const node = matching(scope, text);
  await waitFor(
    () =>
      tab.evaluate(
        `(() => { const el = ${node}; return !!el && !el.disabled; })()`,
      ),
    'Touch target ' + text,
  );
  await tab.evaluate(`(() => { (${node}).click(); return true; })()`);
}

async function fill(tab, selector, value) {
  await waitFor(
    () => tab.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`),
    'Field ' + selector,
  );
  await tab.evaluate(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), 'value').set;
    setter.call(node, ${JSON.stringify(value)});
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
}

const content = (tab, selector, message) =>
  waitFor(
    () =>
      tab.evaluate(
        `document.querySelector(${JSON.stringify(selector)})?.textContent.includes(${JSON.stringify(message)})`,
      ),
    message,
  );
const noOverflow = (tab) =>
  tab.evaluate('document.documentElement.scrollWidth <= window.innerWidth');

try {
  await waitFor(async () => {
    try {
      return (await fetch(origin + '/api/bootstrap')).ok;
    } catch {
      return false;
    }
  }, 'Standalone bootstrap');
  const tokens = seed();
  browser = await browserFixture(origin);
  const login = async (tab, id, width, height) => {
    await tab.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await tab.send('Emulation.setTouchEmulationEnabled', {
      enabled: true,
      maxTouchPoints: 1,
    });
    await tab.send('Network.setCookie', {
      name: 'mobiup_session',
      value: tokens[id],
      url: origin,
      httpOnly: true,
      sameSite: 'Strict',
    });
    await tab.send('Page.navigate', { url: origin });
    await click(tab, '.main-nav [role=tab]', 'Concedii');
  };

  // Configure a real profile in the landscape manager UI.
  await login(browser, manager, 1280, 800);
  await click(browser, '.leave-main-nav button', 'Profiluri');
  await fill(browser, '.leave-profile-select select', agent);
  await fill(browser, '.leave-profile-fields input:nth-of-type(1)', legalName);
  await fill(
    browser,
    '.leave-profile-fields label:nth-child(2) input',
    'Synthetic Employer',
  );
  await fill(
    browser,
    '.leave-profile-fields label:nth-child(3) input',
    'agent@example.test',
  );
  await fill(browser, '.leave-profile-approvers label:first-child input', cc);
  await fill(
    browser,
    '.leave-profile-approvers label:last-child input',
    secondCc,
  );
  await browser.evaluate(
    "document.querySelector('.leave-checkbox input').click()",
  );
  await click(browser, '.leave-profile-form button', 'Salvează profilul');
  await content(
    browser,
    '.leave-profiles .leave-notice',
    'Profilul a fost salvat.',
  );
  assert.ok(await noOverflow(browser), 'Manager landscape fits viewport');

  // Draft a request on a portrait touch viewport. Preview excludes four non-working dates.
  await login(browser, agent, 800, 1200);
  await click(browser, '.leave-header button', 'Cerere nouă');
  await fill(browser, '.leave-date-fields label:first-child input', start);
  await fill(browser, '.leave-date-fields label:last-child input', originalEnd);
  await content(browser, '.leave-period-summary', '2 zile lucrătoare');
  await click(browser, '.leave-editor button', 'Salvează ciorna');
  await content(browser, '.leave-detail .leave-status', 'Ciornă');
  assert.ok(await noOverflow(browser), 'Agent portrait fits viewport');
  assert.equal(
    await browser.evaluate(
      "!!document.querySelector('.leave-detail a[href^=mailto]')",
    ),
    false,
    'Draft has no mail composer',
  );

  await signOnTablet(browser);
  const submit = matching('.leave-detail button', 'Semnează și depune');
  await waitFor(
    () => browser.evaluate(`!(${submit}).disabled`),
    'Touch signature is complete',
  );
  await click(browser, '.leave-detail button', 'Modifică perioada');
  await fill(browser, '.leave-date-fields label:last-child input', end);
  await content(browser, '.leave-period-summary', '3 zile lucrătoare');
  await click(browser, '.leave-editor button', 'Salvează perioada');
  await content(browser, '.leave-detail .leave-status', 'Ciornă');
  assert.equal(
    await browser.evaluate(`(${submit}).disabled`),
    true,
    'Date edits clear existing signature',
  );

  await browser.send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: directory,
  });
  const downloadedPdf = (name) =>
    waitFor(() => {
      try {
        return (
          readFileSync(join(directory, name)).subarray(0, 4).toString() ===
          '%PDF'
        );
      } catch {
        return false;
      }
    }, 'PDF download ' + name);
  // A forged image MIME fails decoding with the draft intact. Clearing selection leaves upload disabled.
  await click(browser, '.leave-switch button', 'Pe hârtie');
  await click(
    browser,
    '.leave-detail button',
    'Descarcă PDF-ul pentru imprimare',
  );
  await downloadedPdf('Cerere-concediu-de-semnat.pdf');
  await browser.evaluate(`(() => {
    const input = document.querySelector('.leave-detail input[type=file]');
    const files = new DataTransfer();
    files.items.add(new File(['not an image'], 'invalid.png', { type: 'image/png' }));
    input.files = files.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await click(browser, '.leave-detail button', 'Încarcă și depune');
  await content(
    browser,
    '.leave-detail [role=alert]',
    'Fotografia nu a putut fi deschisă.',
  );
  await content(browser, '.leave-detail .leave-status', 'Ciornă');
  await browser.evaluate(`(() => {
    const input = document.querySelector('.leave-detail input[type=file]');
    input.value = '';
    input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  assert.equal(
    await browser.evaluate(
      `(${matching('.leave-detail button', 'Încarcă și depune')}).disabled`,
    ),
    true,
  );

  // Submit a fresh touch signature. Inspect the real mailto handoff without opening a mail client.
  await click(browser, '.leave-switch button', 'Pe tabletă');
  await signOnTablet(browser);
  await click(browser, '.leave-detail button', 'Semnează și depune');
  await content(browser, '.leave-detail .leave-status', 'În așteptare');
  const href = await browser.evaluate(
    "document.querySelector('.leave-mail a')?.getAttribute('href')",
  );
  const mail = new URL(href);
  assert.equal(decodeURIComponent(mail.pathname), hr);
  assert.deepEqual(
    mail.searchParams.get('cc').split(',').sort(),
    [cc, secondCc].sort(),
  );
  assert.equal(
    mail.searchParams.get('subject'),
    'Cerere concediu — ' + legalName + ' — 27.11.2026–03.12.2026',
  );
  assert.equal(
    mail.searchParams.get('body'),
    'Bună ziua,\n\nVă transmit atașat cererea de concediu de odihnă pentru perioada 27.11.2026–03.12.2026, însumând 3 zile lucrătoare.\n\n' +
      legalName,
  );
  await content(browser, '.leave-mail dl', filename);
  await click(browser, '.leave-mail button', 'Descarcă PDF-ul');
  await downloadedPdf(filename);

  // Submit a valid photographed page on a second, non-overlapping request.
  await click(browser, '.leave-detail button', 'Înapoi la concedii');
  await click(browser, '.leave-header button', 'Cerere nouă');
  await fill(
    browser,
    '.leave-date-fields label:first-child input',
    '2026-12-07',
  );
  await fill(
    browser,
    '.leave-date-fields label:last-child input',
    '2026-12-08',
  );
  await click(browser, '.leave-editor button', 'Salvează ciorna');
  await click(browser, '.leave-switch button', 'Pe hârtie');
  await browser.evaluate(`(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 420;
    canvas.height = 594;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0,0,420,594);
    ctx.fillStyle = '#181818';
    ctx.font = '20px sans-serif';
    ctx.fillText('Synthetic signed leave request', 30, 90);
    ctx.beginPath();
    ctx.moveTo(60, 210);
    ctx.lineTo(95, 165);
    ctx.lineTo(115, 220);
    ctx.lineTo(155, 186);
    ctx.stroke();
    const image = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    const files = new DataTransfer();
    files.items.add(new File([image], 'synthetic.png', { type: 'image/png' }));
    const input = document.querySelector('.leave-detail input[type=file]');
    input.files = files.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await click(browser, '.leave-detail button', 'Încarcă și depune');
  await content(browser, '.leave-detail .leave-status', 'În așteptare');
  await click(browser, '.leave-mail button', 'Descarcă PDF-ul');
  await downloadedPdf('cerere-concediu-Synthetic-Stefan-Test-2026-12-07.pdf');

  await login(browser, secondManager, 1280, 800);
  await click(browser, '.leave-main-nav button', 'Calendar');
  await fill(browser, '.leave-month input', '2026-12');
  const day = ".leave-calendar-day[aria-label^='2 dec. 2026']";
  await waitFor(
    () =>
      browser.evaluate(
        'document.querySelector(' +
          JSON.stringify(day) +
          ')?.disabled === false',
      ),
    'Pending leave in manager calendar',
  );
  await browser.evaluate(
    'document.querySelector(' + JSON.stringify(day) + ').click()',
  );
  await content(browser, '.leave-calendar-detail .leave-request', legalName);
  await browser.evaluate(
    "document.querySelector('.leave-calendar-detail .leave-request').click()",
  );
  await content(browser, '.leave-detail .leave-status', 'În așteptare');
  await click(browser, '.leave-detail button', 'Respinge');
  const reject = matching('.leave-detail button', 'Confirmă respingerea');
  assert.equal(
    await browser.evaluate(`(${reject}).disabled`),
    true,
    'Rejection requires a reason',
  );
  await fill(
    browser,
    '.leave-detail textarea',
    'Synthetic scheduling conflict',
  );
  await click(browser, '.leave-detail button', 'Confirmă respingerea');
  await content(browser, '.leave-detail .leave-status', 'Respinsă');
  await content(
    browser,
    '.leave-detail .leave-notice strong',
    'Motivul deciziei',
  );

  console.log(
    'PASS tablet leave profiles, calendar day calculation, touch signing, date revision, photo upload and failure, PDFs, mailto and second-manager decision.',
  );
} finally {
  if (browser) await browser.close();
  if (db) db.close();
  server.kill();
  const watchdog = setTimeout(() => server.kill('SIGKILL'), 3000);
  try {
    await exited;
  } finally {
    clearTimeout(watchdog);
  }
  rmSync(directory, { recursive: true, force: true });
}
