import {isAbsolute,relative,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const safeScript = value => typeof value === 'string'
  && value.length <= 1024
  && /^[A-Za-z0-9_~./-]+\.m?js$/.test(value)
  && !value.startsWith('/')
  && value.split('/').every(part => part !== '' && part !== '.' && part !== '..');

// Paths, not basenames, identify artifacts: RSC and SSR both emit index.js.
// Only files in the exact release manifest may lose their host-specific prefix.
export function createBackendFrameNormalizer({root,release,manifest}) {
  if (!isAbsolute(root) || !(typeof release === 'string' && /^[a-f0-9]{40}$/.test(release)) || manifest?.release !== release
      || !manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files))
    throw new Error('Invalid backend artifact identity');
  const scripts = new Map();
  const ids = new Set();
  for (const [name,entry] of Object.entries(manifest.files)) {
    if (!safeScript(name) || !hash(entry?.js) || !hash(entry?.map))
      throw new Error('Invalid backend map entry');
    if (name.startsWith('dist/server/')) {
      if (typeof entry.debug_id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(entry.debug_id) || ids.has(entry.debug_id))
        throw new Error('Invalid or duplicate backend debug identity');
      ids.add(entry.debug_id); scripts.set(name,entry.debug_id);
    }
  }
  const releaseRoot = resolve(root);
  return frame => {
    const value = frame.abs_path || frame.filename;
    if (typeof value !== 'string') return;
    let local;
    try {
      local = value.startsWith('file://') ? fileURLToPath(value) : isAbsolute(value) ? value : undefined;
    } catch { return; }
    if (!local) return;
    const name = relative(releaseRoot,resolve(local)).split(sep).join('/');
    if (!scripts.has(name)) return;
    frame.filename = 'app:///backend/' + name;
    frame.abs_path = frame.filename;
    return {type:'sourcemap',code_file:frame.filename,debug_id:scripts.get(name)};
  };
}
