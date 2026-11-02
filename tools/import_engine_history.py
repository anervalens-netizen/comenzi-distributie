#!/usr/bin/env python3
"""History executor adapter; invoked only by the fixed import-engine executor."""
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import sys
import uuid
import client_history_upload as history
mutation_possible=False


def run(request):
 global mutation_possible
 mutation_possible=False
 job=request['job'];kind=job['kind'];action=request['action'];action_id=request['action_id']
 if kind!='sales_location':return {'state':'failed','error':{'code':'unsupported_kind','message':'Tipul de import nu este încă disponibil.'}}
 if str(uuid.UUID(job['id']))!=job['id'] or str(uuid.UUID(action_id))!=action_id:raise ValueError('Invalid operation ID')
 root=Path(os.environ['MOBIUP_DATA_DIR']).resolve(strict=True)
 dbpath=root/'client-history'/'client-sales-history.sqlite'
 if request['mode']=='reconcile':
  if action=='preview':return {'state':'not_committed'}
  c=sqlite3.connect(dbpath.resolve(strict=True).as_uri()+'?mode=ro',uri=True)
  try:row=c.execute('SELECT value FROM history_meta WHERE key=?',('import_action_receipt:'+action_id,)).fetchone()
  finally:c.close()
  if row:
   receipt=json.loads(row[0])
   if receipt.get('verified') is True and receipt.get('source_sha256')==job['source']['sha256']:
    return {'state':'committed_refresh_pending','receipt':receipt,'result':{'message':'Datele sunt salvate; centralizările necesită verificare.'}}
  return {'state':'uncertain','error':{'code':'reconciliation_required','message':'Rezultatul necesită verificare; importul nu a fost reluat.'}}
 folder=root/'import-engine-spool'/job['id']
 if folder.is_symlink() or not folder.is_dir() or folder.parent.is_symlink():raise ValueError('Invalid source directory')
 path=folder/'source.xlsx'
 if path.is_symlink() or not path.is_file() or path.stat().st_size!=job['source']['size']:raise ValueError('Invalid frozen source')
 with path.open('rb') as source:
  if hashlib.file_digest(source,'sha256').hexdigest()!=job['source']['sha256']:raise ValueError('Frozen source hash mismatch')
 with contextlib.redirect_stdout(sys.stderr):
  rows,summary,month_end=history.parse_upload(path)
  source=job['source']
  if summary['firstDate']<source['date_start'] or summary['lastDate']>source['date_end'] or (not summary['inferredPeriod'] and (summary['from'],summary['through'])!=(source['date_start'],source['date_end'])):
   raise ValueError('Perioada declarată nu corespunde datelor din fișier.')
  lock_path=root/'client-history'/'.upload.lock'
  with lock_path.open('a') as lock:
   fcntl.flock(lock,fcntl.LOCK_EX)
   c=history.open_history(root)
   try:
    if action=='preview':return {'state':'ready','preview':history.preview(c,rows,summary,month_end)}
    if action!='commit':raise ValueError('Invalid history action')
    preview=job.get('preview') or {};options=job.get('options') or {}
    auth=(job.get('payload') or {}).get('commit_authorization')
    if not isinstance(auth,dict):raise ValueError('Missing commit authorization')
    req={'source':str(path),'filename':source['filename'],'revision':preview.get('revision'),'fileHash':preview.get('fileHash'),
         'allowRegression':options.get('allowRegression') is True,'actionId':action_id,'requireAuthorization':True,'directory':str(root),'authorization':auth,
         'actor':job.get('actor'),'declaredPeriod':{'start':source['date_start'],'end':source['date_end']}}
    history.authorized_finish(req,lambda:None)
    mutation_possible=True
    result=history.apply(c,rows,summary,month_end,req,root/'client-history')
    receipt=json.loads(c.execute('SELECT value FROM history_meta WHERE key=?',('import_action_receipt:'+action_id,)).fetchone()[0])
    return {'state':'committed_refresh_pending','receipt':receipt,'result':result}
   finally:c.close()

if __name__=='__main__':
 value=None
 try:
  value=json.load(sys.stdin);out=run(value);print(json.dumps(out,ensure_ascii=False,separators=(',',':')))
 except Exception:
  rejected=isinstance(value,dict) and value.get('mode')=='execute' and not mutation_possible
  state='failed' if rejected else 'uncertain'
  message='Fișierul, perioada sau drepturile nu au putut fi validate.' if rejected else 'Procesarea necesită verificare; importul nu a fost reluat.'
  print(json.dumps({'state':state,'error':{'code':'validation_failed' if rejected else 'execution_uncertain','message':message}}));sys.exit(0)
