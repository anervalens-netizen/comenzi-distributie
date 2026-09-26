"""Isolated checks for the additive Partner Hub schema; never opens live data."""
import json
import sqlite3
from pathlib import Path

sql = (Path(__file__).resolve().parents[1] / 'drizzle/0006_partner_portfolio.sql').read_text()
con = sqlite3.connect(':memory:')
con.execute('PRAGMA foreign_keys=ON')
con.executescript('''
CREATE TABLE users(id TEXT PRIMARY KEY);
CREATE TABLE customers(id TEXT PRIMARY KEY,data TEXT NOT NULL);
CREATE TABLE partner_requests(customer_id TEXT,confirmed_at TEXT);
INSERT INTO users VALUES ('qa-agent');
''')
con.executescript(sql)
con.executescript(sql)
map_index = (Path(__file__).resolve().parents[1] / 'drizzle/0008_partner_map_index.sql').read_text()
con.executescript(map_index)
con.executescript(map_index)
assert con.execute("SELECT name FROM sqlite_master WHERE name='idx_partner_profiles_coordinates'").fetchone()
client = {'address': 'Adresa QA A', 'city': 'Localitate QA', 'county': 'Județ QA', 'route': '1', 'warehouseIds': ['A']}
con.execute('INSERT INTO customers VALUES (?,?)', ('qa-store', json.dumps(client)))
insert = '''INSERT INTO partner_profiles(customer_id,latitude,longitude,position_source,address_fingerprint,updated_at,updated_by)
VALUES ('qa-store',?,?,?,'address-a','2026-09-24T00:00:00Z','qa-agent')'''
con.execute(insert, (45.1, 25.2, 'manual'))

def profile():
    return con.execute('SELECT latitude,longitude,position_source,address_fingerprint,revision FROM partner_profiles').fetchone()

def change(**fields):
    client.update(fields)
    con.execute('UPDATE customers SET data=? WHERE id=?', (json.dumps(client), 'qa-store'))

assert profile() == (45.1, 25.2, 'manual', 'address-a', 1)
change(route='2', warehouseIds=['A', 'B'])
assert profile() == (45.1, 25.2, 'manual', 'address-a', 1), 'membership/route must retain coordinates'
change(address='Adresa QA B')
assert profile() == (None, None, None, '', 2), 'address change must invalidate coordinates'
change(address='Adresa QA A')
assert profile() == (None, None, None, '', 3), 'A -> B -> A must not revive coordinates'
con.execute("UPDATE partner_profiles SET latitude=45.1,longitude=25.2,position_source='gps',address_fingerprint='address-a'")
change(city='Localitate QA nouă')
assert profile()[0] is None and profile()[4] == 4
con.execute("UPDATE partner_profiles SET latitude=45.1,longitude=25.2,position_source='manual'")
change(county='Județ QA nou')
assert profile()[0] is None and profile()[4] == 5
for latitude, longitude, source in [(45, 25, None), (91, 25, 'manual'), (45, 181, 'manual'), (45, None, 'manual'), (45, 25, 'unknown'), (45, 25, 'geocoding')]:
    try:
        con.execute('UPDATE partner_profiles SET latitude=?,longitude=?,position_source=?', (latitude, longitude, source))
    except sqlite3.IntegrityError:
        pass
    else:
        raise AssertionError(f'Invalid coordinates/source accepted: {latitude}, {longitude}, {source}')
con.execute("INSERT INTO partner_visits VALUES ('qa-visit','qa-store','qa-agent','Agent QA','2026-09-24T00:00:00Z','','2026-09-24T00:00:00Z')")
try:
    con.execute("INSERT INTO partner_visits SELECT * FROM partner_visits")
except sqlite3.IntegrityError:
    pass
else:
    raise AssertionError('Duplicate visit id accepted')
assert con.execute('SELECT COUNT(*) FROM partner_visits').fetchone()[0] == 1
assert con.execute('PRAGMA foreign_key_check').fetchall() == []
con.close()
print('PASS: isolated schema checks (idempotent migration, route/shared membership, address/city/county invalidation, A-B-A, coordinate constraints, unique visits, foreign keys).')
