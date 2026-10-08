import assert from 'node:assert/strict';
import {cpSync, existsSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawn} from 'node:child_process';
import net from 'node:net';

// Relocation prevents missing modules being resolved from the build checkout.
const root = mkdtempSync(join(tmpdir(), 'runtime-closure-'));
let child;
try {
  const artifact = join(root, 'release');
  cpSync(resolve('dist/standalone'), artifact, {recursive: true});
  const manifest = JSON.parse(readFileSync(join(artifact, 'runtime-dependencies.json'), 'utf8'));
  for (const name of ['braces', 'micromatch', 'fast-glob', 'shadcn', 'vite-plugin-commonjs', 'vite-plugin-dynamic-import', 'proxy-addr', 'undici', '@modelcontextprotocol/sdk']) {
    assert(!manifest.packages.some(pkg => pkg.name === name), name + ' leaked into runtime');
    assert(!existsSync(join(artifact, 'node_modules', name)), name + ' exists in runtime');
  }
  for (const file of manifest.files) assert(existsSync(join(artifact, file)), 'Missing traced file: ' + file);
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  let output = '';
  child = spawn(process.execPath, ['server.js'], {cwd: artifact, env: {...process.env, NODE_PATH: '', NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port), MOBIUP_DATA_DIR: join(root, 'data')}, stdio: ['ignore', 'pipe', 'pipe']});
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  let ready = false;
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error('Isolated runtime exited: ' + output);
    try { ready = (await fetch(`http://127.0.0.1:${port}/api/bootstrap`)).ok; } catch {}
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert(ready, 'Isolated runtime did not initialize: ' + output);
  for (const path of ['/', '/api/health', '/api/bootstrap', '/?__rsc=1']) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {headers: path.includes('__rsc') ? {RSC: '1'} : {}, signal: AbortSignal.timeout(15000)});
    assert.equal(response.status, 200, path);
    const body = await response.text();
    assert(body.length > 0, 'Empty response: ' + path);
    if (path === '/') {
      assert.match(body, /<html[ >]/i);
      assert.match(body, /<body[ >]/i);
      assert.match(body, /<\/html>/i);
      assert(!body.includes('ERR_MODULE_NOT_FOUND'), 'SSR module failure');
    } else if (path.includes('__rsc')) {
      assert.match(response.headers.get('content-type') ?? '', /text\/x-component/);
      assert(!/\n[0-9a-f]+:E\{/.test(body), 'RSC error envelope');
    } else assert.doesNotThrow(() => JSON.parse(body));
  }
  assert(!/ERR_MODULE_NOT_FOUND|Cannot find module/.test(output), output);
  console.log('PASS: relocated runtime closure, bootstrap, complete SSR and RSC; no build tooling');
} finally {
  if (child && child.exitCode === null) {
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM');
    await exited;
  }
  rmSync(root, {recursive: true, force: true});
}
