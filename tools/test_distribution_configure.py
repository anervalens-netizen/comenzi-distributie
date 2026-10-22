import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from distribution_configure import configure

class ConfigTests(unittest.TestCase):
 def test_recovery_additive_membership_stable_transactions_and_idempotency(self):
  with tempfile.TemporaryDirectory() as folder:
   p=Path(folder);db=p/'application.sqlite';c=sqlite3.connect(db)
   c.executescript("CREATE TABLE users(id,site_code,role,active,warehouse_id);CREATE TABLE settings(key PRIMARY KEY,value);CREATE TABLE customers(id PRIMARY KEY,warehouse_id,data,active);CREATE TABLE orders(id,payload);INSERT INTO users VALUES('agent-a','SITE-A','agent',1,'W-A');INSERT INTO orders VALUES('o','immutable');")
   for id,county,members in [('old','SB',['W-A']),('new','Timiș',['W-B']),('other','AB',['W-A'])]:c.execute('INSERT INTO customers VALUES(?,?,?,1)',(id,members[0],json.dumps({'county':county,'warehouseIds':members,'name':id})))
   c.commit();c.close()
   rules={'version':1,'revision':'synthetic-1','history':'all','assignments':[{'userId':'agent-a','siteCode':'SITE-A','counties':['AB','SB','TM']}],'products':{}}
   result=configure(db,rules,p/'recovery.sqlite',add_counties={'agent-a':['TM']});self.assertEqual(result['addedMemberships'],1)
   c=sqlite3.connect(db);saved=json.loads(c.execute("SELECT data FROM customers WHERE id='new'").fetchone()[0]);self.assertEqual(saved['warehouseIds'],['W-A','W-B']);self.assertEqual(saved['name'],'new');self.assertEqual(c.execute('SELECT * FROM orders').fetchall(),[('o','immutable')]);c.close()
   original=sqlite3.connect(p/'recovery.sqlite');self.assertEqual(json.loads(original.execute("SELECT data FROM customers WHERE id='new'").fetchone()[0])['warehouseIds'],['W-B']);original.close()
   self.assertEqual(configure(db,rules,p/'retry.sqlite',add_counties={'agent-a':['TM']})['addedMemberships'],0)
   rules['assignments'][0]['siteCode']='WRONG'
   with self.assertRaisesRegex(ValueError,'Stale'):configure(db,rules,p/'failed.sqlite')

if __name__=='__main__':unittest.main()
