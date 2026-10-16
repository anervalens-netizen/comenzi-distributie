import hashlib
import json
import pathlib
import sqlite3
import tempfile
import unittest
from crm_location_repair import repair

class RepairTest(unittest.TestCase):
 def test_backup_merge_and_override(self):
  with tempfile.TemporaryDirectory() as folder:
   db=pathlib.Path(folder)/'copy.sqlite';backup=pathlib.Path(folder)/'backup.sqlite'
   with sqlite3.connect(db) as c:
    c.executescript('CREATE TABLE customers(id TEXT PRIMARY KEY,warehouse_id TEXT,data TEXT,active INTEGER);CREATE TABLE crm_locations(address_id TEXT PRIMARY KEY,county TEXT,source_json TEXT);CREATE TABLE orders(id TEXT,payload TEXT);')
    for ident in ['a','b']:
     c.execute('INSERT INTO customers VALUES(?,?,?,1)',(ident,'w-'+ident,json.dumps({'id':ident,'cui':'900000001','county':'AB','warehouseId':'w-'+ident,'warehouseIds':['w-'+ident],'crm':{'metadata':ident}})))
    c.execute("INSERT INTO crm_locations VALUES('loc','AB','{\"county\":\"AB\"}')")
    c.execute('INSERT INTO orders VALUES(?,?)',('historical',json.dumps({'client':{'id':'a'},'status':'finalized'})))
   with sqlite3.connect(db) as c, sqlite3.connect(backup) as b:c.backup(b)
   checksum=hashlib.sha256(backup.read_bytes()).hexdigest()
   plan={'counties':[{'kind':'customer','id':'b','county':'BV'},{'kind':'crm','id':'loc','county':'BV'}],'merges':[{'from':'a','into':'b'}]}
   with self.assertRaises(ValueError):repair(db,backup,'wrong',plan,True)
   invalid={'counties':plan['counties'],'merges':[{'from':'a','into':'missing'}]}
   with self.assertRaises(ValueError):repair(db,backup,checksum,invalid,True)
   # Earlier county writes and schema creation rolled back with the failed merge.
   with sqlite3.connect(db) as c:
    self.assertEqual(c.execute('SELECT county FROM crm_locations').fetchone()[0],'AB')
    self.assertFalse(c.execute("SELECT 1 FROM sqlite_master WHERE name='location_county_overrides'").fetchone())
   self.assertFalse(repair(db,backup,checksum,plan)['applied'])
   result=repair(db,backup,checksum,plan,True)
   self.assertEqual(result['merges'][0]['orderReferences'],['historical'])
   with sqlite3.connect(db) as c:
    self.assertEqual(c.execute("SELECT active FROM customers WHERE id='a'").fetchone()[0],0)
    self.assertEqual(c.execute('SELECT source_json FROM crm_locations').fetchone()[0],'{"county":"AB"}')
    c.execute("UPDATE crm_locations SET county='AB'")
    self.assertEqual(c.execute('SELECT county FROM crm_locations').fetchone()[0],'BV')
    c.execute("UPDATE customers SET data=json_set(data,'$.county','AB') WHERE id='b'")
    self.assertEqual(json.loads(c.execute("SELECT data FROM customers WHERE id='b'").fetchone()[0])['county'],'BV')
    c.execute("UPDATE customers SET active=1 WHERE id='a'")
    self.assertEqual(c.execute("SELECT active FROM customers WHERE id='a'").fetchone()[0],0)
   with self.assertRaises(ValueError):repair(db,backup,checksum,plan,True)

if __name__=='__main__':unittest.main()
