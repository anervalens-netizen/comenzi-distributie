import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createNativeCustomerStorageFixture } from './customer-sqlite-fixture.mjs';
import { runCustomerStorageContract } from './customer-storage-contract.mjs';

const probe = createNativeCustomerStorageFixture();
const sqliteVersion = probe.sqliteVersion;
await probe.close();
const cases = [];
const source = Object.fromEntries(
  [
    'customer-sqlite-fixture.mjs',
    'customer-storage-contract.mjs',
    'test-customer-storage-sqlite.mjs',
  ].map((name) => [
    name,
    createHash('sha256')
      .update(readFileSync(new URL(name, import.meta.url)))
      .digest('hex'),
  ]),
);
try {
  const result = await runCustomerStorageContract(
    createNativeCustomerStorageFixture,
    {
      onCase: (record) => {
        cases.push(record);
      },
    },
  );
  console.log(
    JSON.stringify({
      kind: 'customer-native-storage-contract',
      schema_version: 1,
      node: process.version,
      sqliteVersion,
      source,
      ...result,
    }),
  );
} catch (error) {
  console.log(
    JSON.stringify({
      kind: 'customer-native-storage-contract',
      schema_version: 1,
      node: process.version,
      sqliteVersion,
      source,
      passed: false,
      caseCount: cases.length,
      cases,
      error: { name: error.name, message: error.message },
    }),
  );
  console.error(error);
  process.exitCode = 1;
}
