import {isAbsolute,relative,resolve,sep,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const safeScript = value => typeof value === 'string'
  && value.length <= 1024
  && /^[A-Za-z0-9_~./-]+\.m?js$/.test(value)
  && !value.startsWith('/')
  && value.split('/').every(part => part !== '' && part !== '.' && part !== '..');

// Paths, not basenames, identify artifacts: RSC and SSR both emit index.js.
// Both the runtime bytes and private evidence must match the exact manifest.
export function createBackendFrameNormalizer({root,release,manifest}) {
  if (!isAbsolute(root) || !(typeof release === 'string' && /^[a-f0-9]{40}$/.test(release)) || manifest?.release !== release
      || !manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files))
    throw new Error('Invalid backend artifact identity');
  const releaseRoot = resolve(root);
  const scripts = new Map();
  const ids = new Set();
  const verified = (name,entry) => {
    try {
      const script=readFileSync(join(releaseRoot,name));
      const privateScript=readFileSync(join(releaseRoot,'.private-source-maps/backend',name));
      const map=readFileSync(join(releaseRoot,'.private-source-maps/backend',name+'.map'));
      return digest(script) === entry.js && digest(privateScript) === entry.js && digest(map) === entry.map
        && script.toString('utf8').trimEnd().endsWith('//# debugId='+entry.debug_id)
        && JSON.parse(map.toString('utf8')).debug_id === entry.debug_id;
    } catch { return false; }
  };
  for (const [name,entry] of Object.entries(manifest.files)) {
    if (!safeScript(name) || !hash(entry?.js) || !hash(entry?.map))
      throw new Error('Invalid backend map entry');
    if (name.startsWith('dist/server/')) {
      if (typeof entry.debug_id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(entry.debug_id) || ids.has(entry.debug_id))
        throw new Error('Invalid or duplicate backend debug identity');
      if (!verified(name,entry)) throw new Error('Backend artifact bytes do not match manifest');
      ids.add(entry.debug_id); scripts.set(name,entry);
    }
  }
  return frame => {
    const value = frame.abs_path || frame.filename;
    if (typeof value !== 'string') return;
    let local;
    try {
      local = value.startsWith('file://') ? fileURLToPath(value) : isAbsolute(value) ? value : undefined;
    } catch { return; }
    if (!local) return;
    const name = relative(releaseRoot,resolve(local)).split(sep).join('/');
    const entry = scripts.get(name);
    // Lazy bundles may change after process start; never use an ID for new bytes.
    if (!entry || !verified(name,entry)) return;
    frame.filename = 'app:///backend/' + name;
    frame.abs_path = frame.filename;
    return {type:'sourcemap',code_file:frame.filename,debug_id:entry.debug_id};
  };
}
