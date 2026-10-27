#!/usr/bin/env python3
"""Add a read-lookup index without changing imported rows or reconciliation."""
import argparse,fcntl,json,sqlite3
from pathlib import Path

def prepare(root):
    root=Path(root).resolve()
    if not root.is_dir():raise ValueError('Existing activation root required')
    with (root/'.activation-job.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        pointer=root/'current';directory=root
        if pointer.is_symlink():
            directory=pointer.resolve(strict=True)
            if directory.parent!=root/'generations':raise ValueError('Invalid generation location')
        elif pointer.exists():raise ValueError('Invalid generation pointer')
        c=sqlite3.connect((directory/'activations.sqlite').as_uri()+'?mode=rw',uri=True,timeout=30)
        try:
            if c.execute("SELECT value FROM activation_meta WHERE key='schema_version'").fetchone()!=('3',):raise ValueError('Unsupported ledger')
            tables=['activation_imports','activation_movements','activation_occurrences','activation_facts','activation_observations','activation_effective_movements']
            before={t:c.execute('SELECT COUNT(*) FROM '+t).fetchone()[0] for t in tables}
            c.execute('CREATE INDEX IF NOT EXISTS activation_movements_serial ON activation_movements(company,provider,serial)');c.commit()
            after={t:c.execute('SELECT COUNT(*) FROM '+t).fetchone()[0] for t in tables}
            if before!=after or c.total_changes:raise RuntimeError('Unexpected row changes')
            plan=c.execute("EXPLAIN QUERY PLAN SELECT id FROM activation_movements INDEXED BY activation_movements_serial WHERE company=? AND provider=? AND serial=?",('ExampleCo','vodafone','0'*18)).fetchall()
            if not any('SEARCH' in r[3] and 'activation_movements_serial' in r[3] for r in plan):raise RuntimeError('Lookup index not selected')
            checkpoint=list(c.execute('PRAGMA wal_checkpoint(FULL)').fetchone())
            if checkpoint[0]!=0 or checkpoint[1]!=checkpoint[2]:raise RuntimeError('Index checkpoint incomplete')
            return {'status':'PASS','checkpoint':checkpoint,'rowsUnchanged':before,'rowChanges':c.total_changes,'index':'activation_movements_serial'}
        finally:c.close()
if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--data-dir',type=Path,required=True);args=parser.parse_args();print(json.dumps(prepare(args.data_dir)))
