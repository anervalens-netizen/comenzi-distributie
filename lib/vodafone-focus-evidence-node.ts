import {lstatSync} from 'node:fs';
import {basename, dirname, join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';

export function readFocusEvidence<T>(
  directory: string, generation: string, facts: string, imports: string, ledger: DatabaseSync,
  calculate: (source: DatabaseSync) => T,
): T {
  const path = join(directory, 'vodafone-focus-evidence.sqlite');
  let evidence: DatabaseSync | undefined;
  try {
    if (basename(dirname(directory)) === 'generations' && generation &&
        lstatSync(path, {throwIfNoEntry: false})?.isFile()) {
      evidence = new DatabaseSync(path, {readOnly: true, timeout: 100});
      evidence.exec('BEGIN');
      const manifest = evidence.prepare('SELECT format,directory,generation,facts,imports FROM focus_manifest').get();
      if (manifest?.format === '1' && manifest.directory === basename(directory) &&
          manifest.generation === generation && manifest.facts === facts && manifest.imports === imports) {
        return calculate(evidence);
      }
    }
  } catch {
    // A missing or unreadable optional projection must not hide valid source evidence.
  } finally {
    evidence?.close();
  }
  return calculate(ledger);
}
