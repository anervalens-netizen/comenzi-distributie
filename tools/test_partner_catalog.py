import json
import sqlite3
import tempfile
import unittest
from contextlib import chdir, closing
from pathlib import Path

from partner_catalog import SOURCES, open_catalog
from partner_catalog_trace import trace_documents


def setup(root, key, script):
    path = root / (SOURCES | {'vodafone':'activations.sqlite','digi':'digi/activations.sqlite'})[key]
    path.parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(path)) as db:
        db.executescript(script)
        db.commit()


class CatalogTest(unittest.TestCase):
    def test_crosswalk_and_source_grains(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            setup(root, 'crm', """
                CREATE TABLE crm_companies(partner_id, name, cif, partner_code, source_hash);
                INSERT INTO crm_companies VALUES ('A','Example A','RO12345','A-X','v'),('B','Example B','67890','B-X','v');
                CREATE TABLE crm_locations(address_id,partner_id,franchise_code,synthetic_name,city,county,street,local_number);
                INSERT INTO crm_locations VALUES ('1','A','F1','One','','','', ''),('2','A','F2','Two','','','','');
                CREATE TABLE customers(id PRIMARY KEY, active, data);
                INSERT INTO customers VALUES ('x',1,'{"cui":"12345","name":"one"}'),('y',1,'{"cui":"67890"}'),('z',0,'{}');
                CREATE TABLE crm_customer_links(customer_id,address_id,method);
                INSERT INTO crm_customer_links VALUES ('x','1','explicit'),('y','1','old');
                CREATE TABLE customer_identity_aliases(alias_id,canonical_id);
                INSERT INTO customer_identity_aliases VALUES ('before','x');
                CREATE TABLE users(active,role,site_code,warehouse_id);
                INSERT INTO users VALUES (1,'agent','S','W'),(1,'agent','DUP','W'),(1,'agent','DUP','W2');
                CREATE TABLE orders(id,kind,status,finalized_at,payload);
                INSERT INTO orders VALUES ('d','stand_client','finalized','2026-01-03','{"client":{"id":"before","cui":"12345"}}'),
                                          ('e','sim','draft',NULL,'{}'),('c','combined','finalized','2026-01-03','{"serials":["s"],"client":{"id":"x","cui":"12345"}}');
            """)
            setup(root, 'history', """
                CREATE TABLE history_identities(id,client_code,franchise_code);
                INSERT INTO history_identities VALUES (1,'A-X','F1'),(2,'67890','F1'),(3,'unknown','F2'),(4,'12345','');
                CREATE TABLE history_rows(import_id,sheet,source_row,date,document_number,identity_id,item_code,quantity_micros,value_cents,site_id,customer_name);
                CREATE TABLE history_imports(id,state);
                INSERT INTO history_imports VALUES (1,'active'),(2,'replaced');
                INSERT INTO history_rows VALUES (1,'Sheet',3,'2026-01-02','N',1,'P',1000000,123,'site','Example A'),(2,'Sheet',3,'2026-01-02','N',1,'P',1000000,111,'site','Example A');
            """)
            setup(root, 'seller', """
                CREATE TABLE sales_rows(import_id,month,row_number,date,site_code,item_code,quantity,value_cents);
                CREATE TABLE sales_months(month,import_id);
                INSERT INTO sales_rows VALUES (1,'2026-01',1,'2026-01-02','S','P',1,123),(2,'2026-01',1,'2026-01-02','S','P',1,111);
                INSERT INTO sales_months VALUES ('2026-01',1);
            """)
            for provider, raw in [('digi',{'Denumire Client':'Example A'}),('vodafone',{'CIF':'12345','CodPunctDeLucru':'F1','SiteId':'site','Nr':'N','Denumire Client':'Example A'})]:
                setup(root, provider, """
                    CREATE TABLE activation_effective_movements(movement_id,movement_date,site,is_tr,item_code,quantity,raw_json,company);
                """)
                with closing(sqlite3.connect(root/('activations.sqlite' if provider=='vodafone' else 'digi/activations.sqlite'))) as conn:
                    conn.execute("INSERT INTO activation_effective_movements VALUES (1,'2026-01-02','DUP',1,'SIM',1,?,'issuer')",(json.dumps(raw),))
                    conn.commit()

            with chdir(root.parent), open_catalog(Path(root.name), Path(root.name)) as db:
                self.assertEqual(db.execute('SELECT count(*) FROM catalog_digi_movements').fetchone()[0],1)
            with open_catalog(root) as db:
                def rows(query):
                    return [tuple(r) for r in db.execute(query)]
                self.assertEqual(rows('SELECT identity_id,company_id,point_key FROM catalog_erp_identity ORDER BY 1'),
                                 [(1,'A','crm:1'),(2,'B',None),(3,None,None),(4,'A',None)])
                self.assertEqual(rows('SELECT customer_id,point_key FROM catalog_portfolio ORDER BY 1'),
                                 [('x','crm:1'),('y','portfolio:y'),('z','portfolio:z')])
                self.assertEqual(rows('SELECT count(*) FROM catalog_points'),[(4,)])
                self.assertEqual(rows('SELECT value_cents FROM catalog_erp_sales'), [(123,)])
                self.assertEqual(rows('SELECT current_warehouse_id,value_cents FROM catalog_agent_sales'),[('W',123)])
                self.assertEqual(rows('SELECT company_id,point_key FROM catalog_vodafone_movements'),[('A','crm:1')])
                self.assertEqual(rows('SELECT current_warehouse_id,reported_customer_name FROM catalog_digi_movements'),[(None,'Example A')])
                self.assertEqual(rows('SELECT order_id,point_key FROM catalog_delivery_points ORDER BY order_id'),[('c','crm:1'),('d','crm:1')])
                # A partner code alone is not a matching historic fiscal identifier.
                self.assertEqual(trace_documents(db,[1])[0]['document_evidence'], 'document without matching verified identifiers')
                with self.assertRaises(sqlite3.OperationalError):
                    db.execute('DELETE FROM crm.customers')
                with self.assertRaises(sqlite3.OperationalError):
                    db.execute('DELETE FROM catalog_portfolio')

            with closing(sqlite3.connect(root/SOURCES['history'])) as h:
                h.execute("UPDATE history_identities SET client_code='12345' WHERE id=1")
                h.commit()
            with open_catalog(root) as db:
                self.assertEqual(trace_documents(db,[1,1])[0]['document_evidence'], 'historical client and point corroborated')
            with closing(sqlite3.connect(root/'activations.sqlite')) as v:
                v.execute("INSERT INTO activation_effective_movements SELECT 2,movement_date,site,is_tr,item_code,quantity,json_set(raw_json,'$.CIF','67890'),company FROM activation_effective_movements")
                v.commit()
            with open_catalog(root) as db:
                self.assertEqual(trace_documents(db,[1])[0]['document_evidence'], 'ambiguous document')

            with closing(sqlite3.connect(root/SOURCES['crm'])) as crm:
                crm.execute('DROP TABLE customer_identity_aliases')
                crm.commit()
            with open_catalog(root, root/'missing') as db:
                self.assertEqual(db.execute("SELECT count(*) FROM catalog_delivery_points").fetchone()[0],2)
                self.assertEqual(db.execute("SELECT available FROM catalog_sources WHERE register='vodafone'").fetchone()[0],0)
            net=root/'operators'
            generation=net/'generations'/'first'
            generation.mkdir(parents=True)
            (root/'activations.sqlite').rename(generation/'activations.sqlite')
            (net/'current').symlink_to(generation)
            with open_catalog(root, net) as db:
                self.assertEqual(db.execute('SELECT count(*) FROM catalog_vodafone_movements').fetchone()[0],2)


if __name__=='__main__':
    unittest.main()
