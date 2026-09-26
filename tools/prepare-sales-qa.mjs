import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes, scryptSync } from 'node:crypto';

// Synthetic local accounts only; never run against the production directory.
const folder = resolve('work/sales-acceptance-20260914');
mkdirSync(folder, { recursive: true });
const filename = resolve(folder, 'mobiup.sqlite');
if (existsSync(filename)) throw new Error('QA database already exists; refusing to overwrite.');
const db = new DatabaseSync(filename);
db.exec(readFileSync('drizzle/0000_rare_hardball.sql', 'utf8'));
db.exec("ALTER TABLE users ADD COLUMN warehouse_name TEXT; ALTER TABLE users ADD COLUMN site_code TEXT NOT NULL DEFAULT ''; ALTER TABLE users ADD COLUMN manager_scope TEXT NOT NULL DEFAULT 'assigned'; CREATE TABLE manager_agents (manager_id TEXT NOT NULL, agent_id TEXT NOT NULL, PRIMARY KEY(manager_id,agent_id));");
const password = 'Sales-QA-2026-only';
const salt = randomBytes(16).toString('hex');
const hash = `scrypt:${salt}:${scryptSync(password, salt, 32, { N: 32768, r: 8, p: 3, maxmem: 40 * 1024 * 1024 }).toString('hex')}`;
const add = db.prepare('INSERT INTO users (id,username,name,role,manager_scope,warehouse_id,password_hash,must_change_password,warehouse_name,site_code) VALUES (?,?,?,?,?,?,?,0,?,?)');
add.run('sales-manager', 'sales.manager', 'Manager verificare', 'manager', 'global', null, hash, null, '');
add.run('sales-regional', 'sales.regional', 'Manager regional verificare', 'manager', 'assigned', null, hash, null, '');
add.run('sales-agent', 'sales.agent', 'Agent verificare', 'agent', 'assigned', 'g-2', hash, 'Gestiune DAVIDD', 'DAVIDD');
add.run('sales-other', 'sales.other', 'Alt agent', 'agent', 'assigned', 'g-5', hash, 'Gestiune TR01PH', 'TR01PH');
add.run('sales-pending', 'sales.pending', 'Agent în curs de angajare', 'agent', 'assigned', 'g-15', hash, null, '');
db.prepare("INSERT INTO manager_agents(manager_id,agent_id) VALUES ('sales-regional','sales-agent')").run();
db.prepare("INSERT INTO settings (key,value) VALUES ('seed-v1','1')").run();
db.close();
console.log('Prepared isolated sales acceptance database.');
