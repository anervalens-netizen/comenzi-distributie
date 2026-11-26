import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync, statSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

export function verifyAgentsAlpha(root = process.cwd()) {
  const manifest = JSON.parse(readFileSync(join(root, 'tools/agents-alpha-manifest.json'), 'utf8'));
  assert.equal(process.platform + '-' + process.arch, manifest.platform, 'Install the official native bundle for this platform');
  const glibc = process.report.getReport().header.glibcVersionRuntime;
  const [major, minor] = (glibc ?? '0.0').split('.').map(Number);
  const [requiredMajor, requiredMinor] = manifest.minimumGlibc.split('.').map(Number);
  assert(major > requiredMajor || (major === requiredMajor && minor >= requiredMinor), 'Native Agents requires glibc >= ' + manifest.minimumGlibc);
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  const runtimeFiles = [];
  for (const pkg of manifest.packages) {
    const path = 'node_modules/' + pkg.name;
    const installed = JSON.parse(readFileSync(join(root, path, 'package.json'), 'utf8'));
    assert.equal(installed.version, manifest.release.slice(1), pkg.name + ' version');
    assert.equal(lock.packages[path]?.resolved, pkg.url, pkg.name + ' release URL');
    assert.equal(lock.packages[path]?.integrity, pkg.integrity, pkg.name + ' archive integrity');
  }
  for (const asset of manifest.runtimeFiles) {
    const file = 'node_modules/@openai/agents-codex/' + asset.path;
    const path = join(root, file);
    assert.equal(statSync(path).size, asset.size, file + ' size');
    assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), asset.sha256, file + ' SHA256');
    runtimeFiles.push(file);
  }
  return runtimeFiles;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  verifyAgentsAlpha();
  console.log('Verified matching official Agents alpha packages and native runtime assets.');
}
