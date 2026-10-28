#!/usr/bin/env python3
"""Stage, validate and atomically publish one network generation under an explicit private root."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import shutil
import sqlite3
import uuid
import activations
from activation_report import build_report, build_report_incremental, IncrementalReportUnavailable


def run_job(directory,batches,rules=None,before_publish=None):
    root=Path(directory).resolve();root.mkdir(mode=0o700,parents=True,exist_ok=True)
    with (root/'.activation-job.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        current=(root/'current').resolve() if (root/'current').is_symlink() else root
        generations=root/'generations'
        if generations.is_symlink():raise ValueError('Invalid generation directory')
        generations.mkdir(mode=0o700,exist_ok=True)
        if current!=root and (current.parent!=generations or not current.is_dir()):raise ValueError('Invalid current generation')
        stage=generations/str(uuid.uuid4());stage.mkdir(mode=0o700)
        try:
            source_path=current/'activations.sqlite'
            if source_path.exists():
                source=sqlite3.connect(source_path.as_uri()+'?mode=ro',uri=True);target=sqlite3.connect(stage/'activations.sqlite')
                try:source.backup(target)
                finally:source.close();target.close()
                originals=current/'activation-originals'
                if originals.exists():
                    (stage/'activation-originals').mkdir(mode=0o700)
                    for p in originals.glob('*.xlsx'):
                        if p.is_symlink() or not p.is_file() or activations.digest(p)!=p.stem:raise ValueError('Invalid retained original')
                        os.link(p,stage/'activation-originals'/p.name)
            c=activations.connect(stage)
            receipts=[]; import_ids=[]; old_generation=None; delta=None
            try:
                old=c.execute("SELECT value FROM activation_meta WHERE key='generation'").fetchone()
                old_generation=old[0] if old else None
                for batch in batches:
                    options=dict(batch);paths=[Path(p) for p in options.pop('files')]
                    receipt=activations.import_files(c,stage,paths,defer_rebuild=True,**options)
                    import_ids.extend(r['import_id'] for r in receipt['files'] if r['status']=='imported')
                    receipts.append(receipt)
                # The staged copy is private; commit all affected components as a
                # single reconciliation after every source has been imported.
                c.execute('BEGIN IMMEDIATE')
                try:
                    delta=activations.reconcile_imports(c,import_ids)
                    c.commit()
                except BaseException:
                    c.rollback()
                    raise
                if c.execute('PRAGMA integrity_check').fetchone()[0]!='ok' or c.execute('PRAGMA foreign_key_check').fetchall():raise ValueError('Invalid ledger')
                c.execute('PRAGMA wal_checkpoint(TRUNCATE)')
            finally:c.close()
            report_path=current/'activation-report.sqlite'
            fallback=None
            if delta['full'] or not report_path.is_file() or not old_generation:
                fallback='full ledger reconciliation or no previous report'
            else:
                os.link(report_path,stage/'activation-report.sqlite')
                try:
                    report=build_report_incremental(stage,delta,old_generation,rules)
                except IncrementalReportUnavailable as exc:
                    fallback=str(exc)
            if fallback:
                report=build_report(stage,rules)
                report['rebuildReason']=fallback
            if before_publish:before_publish(stage)
            for name in ['activations.sqlite','activation-report.sqlite']:
                with (stage/name).open('rb') as f:os.fsync(f.fileno())
            fd=os.open(stage,os.O_RDONLY)
            try:os.fsync(fd)
            finally:os.close(fd)
            pointer=root/('.current-'+str(uuid.uuid4()))
            pointer.symlink_to(stage.relative_to(root),target_is_directory=True)
            os.replace(pointer,root/'current')
            fd=os.open(root,os.O_RDONLY)
            try:os.fsync(fd)
            finally:os.close(fd)
            return {'generation':stage.name,'previousGeneration':current.name if current!=root else 'legacy','imports':receipts,'report':report}
        except BaseException:
            # Keep failed staging and originals for private diagnosis. The old pointer is unchanged.
            raise

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--data-dir',type=Path,required=True);p.add_argument('--manifest',type=Path,required=True);p.add_argument('--rules',type=Path)
    a=p.parse_args();os.umask(0o077)
    print(json.dumps(run_job(a.data_dir,json.loads(a.manifest.read_text()),json.loads(a.rules.read_text()) if a.rules else None)))
