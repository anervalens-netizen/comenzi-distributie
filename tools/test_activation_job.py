import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from activation_job import run_job
from test_activations import fixture,row

class JobTests(unittest.TestCase):
 def test_atomic_generation_interruption_and_replay(self):
  with tempfile.TemporaryDirectory() as folder:
   root=Path(folder);data=root/'data';file=fixture(root/'one.xlsx',[row()]);batch={'files':[str(file)],'operator':'vodafone'}
   first=run_job(data,[batch]);old=(data/'current').resolve()
   file2=fixture(root/'two.xlsx',[row(DocumentDetailId='NEW',IMEI='0000000000000000020',Activat='000000000000000002')])
   def crash(stage):raise RuntimeError('synthetic interruption')
   with self.assertRaisesRegex(RuntimeError,'interruption'):run_job(data,[{'files':[str(file2)],'operator':'vodafone'}],before_publish=crash)
   self.assertEqual((data/'current').resolve(),old)
   c=sqlite3.connect(old/'activations.sqlite');self.assertEqual(c.execute('SELECT COUNT(*) FROM activation_imports').fetchone()[0],1);c.close()
   retry=run_job(data,[batch]);self.assertEqual(retry['imports'][0]['files'][0]['status'],'already_imported');self.assertNotEqual(first['generation'],retry['generation'])

 def test_simultaneous_same_source_has_one_import(self):
  with tempfile.TemporaryDirectory() as folder:
   root=Path(folder);file=fixture(root/'one.xlsx',[row()]);manifest=root/'manifest.json';manifest.write_text(json.dumps([{'files':[str(file)],'operator':'vodafone'}]))
   command=[sys.executable,str(Path(__file__).with_name('activation_job.py')),'--data-dir',str(root/'data'),'--manifest',str(manifest)]
   children=[subprocess.Popen(command,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True) for _ in range(2)]
   for child in children:
    out,err=child.communicate(timeout=30);self.assertEqual(child.returncode,0,err)
   c=sqlite3.connect((root/'data/current').resolve()/'activations.sqlite');self.assertEqual(c.execute('SELECT COUNT(*) FROM activation_imports').fetchone()[0],1);self.assertEqual(c.execute('SELECT COUNT(*) FROM activation_movements').fetchone()[0],1);c.close()

if __name__=='__main__':unittest.main()
