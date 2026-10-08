import {nodeFileTrace} from '@vercel/nft';
import {cpSync, existsSync, globSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, join, relative, resolve} from 'node:path';

// Trace every emitted server chunk and worker, including lazy route entries.
// Rebuild the dependency directory from reachable files, rather than shipping
// the framework's entire CLI/build dependency tree. Trace both RSC and SSR.
export async function packageRuntime(directory) {
  const base = resolve(directory);
  const entries = [...globSync('**/*.js', {cwd: base, exclude: ['node_modules/**', 'public/**', 'dist/client/**']}),
    ...globSync('*.mjs', {cwd: base})].sort((a, b) => a.localeCompare(b));
  if (!entries.includes('server.js')) throw new Error('Missing runtime entry');
  const source = resolve('.');
  // Ignore Vinext's flattened copy: it can select a different transitive
  // version than the source resolver. Keep the installed nested layout.
  rmSync(join(base, 'node_modules'), {recursive: true, force: true});
  const files = new Set();
  for (const conditions of [['node', 'import', 'require', 'production'], ['node', 'import', 'require', 'production', 'react-server']]) {
    const trace = await nodeFileTrace(entries.map(file => join(base, file)), {base: source, processCwd: base, conditions});
    if (trace.warnings.size) throw new Error([...trace.warnings].map(error => error.message).join('\n'));
    for (const file of trace.fileList) {
      if (file.startsWith('../')) throw new Error('Runtime dependency escapes standalone output: ' + file);
      if (!file.startsWith('node_modules/') && !file.startsWith(relative(source, base) + '/')) throw new Error('Unexpected runtime file: ' + file);
      files.add(file);
    }
  }
  const packages = [];
  for (const file of [...files].sort((a, b) => a.localeCompare(b))) {
    if (!file.startsWith('node_modules/') || !file.endsWith('/package.json')) continue;
    const pkg = JSON.parse(readFileSync(join(source, file), 'utf8'));
    if (!pkg.name || !pkg.version) continue;
    packages.push({name: pkg.name, version: pkg.version, path: dirname(file)});
    for (const license of globSync('{LICENSE*,LICENCE*,COPYING*,NOTICE*}', {cwd: join(source, dirname(file))})) files.add(join(dirname(file), license));
  }
  const staging = join(base, '.runtime-node-modules');
  if (existsSync(staging)) throw new Error('Runtime staging directory already exists');
  mkdirSync(staging);
  try {
    for (const file of [...files].sort((a, b) => a.localeCompare(b))) {
      if (!file.startsWith('node_modules/')) continue;
      const target = join(staging, file.slice('node_modules/'.length));
      mkdirSync(dirname(target), {recursive: true});
      cpSync(join(source, file), target, {dereference: true});
    }
    
    renameSync(staging, join(base, 'node_modules'));
    writeFileSync(join(base, 'runtime-dependencies.json'), JSON.stringify({schema: 1, entries, packages, files: [...files].filter(file => file.startsWith('node_modules/')).sort((a, b) => a.localeCompare(b))}, null, 2) + '\n');
  } finally {
    rmSync(staging, {recursive: true, force: true});
  }
  return packages;
}
