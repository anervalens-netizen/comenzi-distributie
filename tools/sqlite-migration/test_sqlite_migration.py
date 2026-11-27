"""Synthetic tests for full-scope capture, publication and data evidence."""
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import tempfile
import time
import unittest
from unittest.mock import patch

import sqlite_migration as migration

REVISION = "a" * 40


def create_database(path, statements="CREATE TABLE sample(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO sample VALUES(1,'fixture');"):
    path.parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(path)) as c:
        c.execute("PRAGMA journal_mode=WAL")
        c.executescript(statements)
        c.commit()


def fixture(root):
    data = root / "data"
    data.mkdir()
    for name in ("mobiup.sqlite", "sales.sqlite", "usage.sqlite", "client-history/client-sales-history.sqlite",
                 "client-history/partner-activity.sqlite"):
        create_database(data / name)
    for provider in ("vodafone", "digi"):
        base = data / "activations" / ("digi" if provider == "digi" else "")
        generation = base / "generations/generic-generation"
        generation.mkdir(parents=True)
        (base / ".activation-job.lock").touch()
        (base / "current").symlink_to("generations/generic-generation")
        create_database(generation / "activations.sqlite", """
            CREATE TABLE activation_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
            INSERT INTO activation_meta VALUES('schema_version','3'),('generation','generic-generation');
            CREATE TABLE activation_imports(sha256 TEXT,operator TEXT,row_count INTEGER,parser_version TEXT,status TEXT);
            INSERT INTO activation_imports VALUES('generic-hash','generic-provider',3,'1','complete');
        """)
        create_database(generation / "activation-report.sqlite", "CREATE TABLE report_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);")
        with closing(sqlite3.connect(generation / "activation-report.sqlite")) as c:
            c.executemany("INSERT INTO report_meta VALUES(?,?)", [
                ("sourceGeneration", "generic-generation"),
                ("sourceImports", json.dumps([["generic-hash", "generic-provider", 3, "1"]], separators=(",", ":")))])
            c.commit()
        if provider == "vodafone":
            create_database(generation / "vodafone-focus-evidence.sqlite")
    return data


class MigrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.data = fixture(self.root)

    def capture(self, name="capture", **kwargs):
        return migration.snapshot(self.data, None, self.root / name, REVISION,
                                  max_bytes=128 * 1024 ** 2, min_free_bytes=0, **kwargs)

    def test_catalog_inventory_accounts_for_all_ten_files(self):
        result = migration.inventory(self.data, None, REVISION)
        self.assertEqual(set(result["databases"]), migration.EXPECTED)
        self.assertEqual(sum(r["kind"] == "authoritative" for r in result["databases"].values()), 8)
        self.assertFalse(result["business_rows_read"])
        self.assertTrue(result["activation_pairs"]["vodafone"]["pair_validated"])
        self.assertFalse(result["cross_database_consistency_verified"])

    def test_complete_quiescent_snapshot_is_sealed_and_scoped(self):
        result = self.capture()
        self.assertEqual(len(result["databases"]), 10)
        self.assertTrue(result["cross_database_consistency_verified"])
        self.assertFalse(result["production_cutover_ready"])
        for key, item in result["databases"].items():
            copied = self.root / "capture" / item["file"]
            self.assertEqual(migration.digest(copied), item["sha256"])
            self.assertFalse(Path(str(copied) + "-wal").exists())
            self.assertEqual(copied.stat().st_mode & 0o777, 0o600)
        self.assertFalse(list(self.root.glob(".sqlite-migration-*")))

    def test_missing_principal_fails_without_partial_result(self):
        (self.data / "usage.sqlite").unlink()
        with self.assertRaises((OSError, migration.MigrationError)):
            self.capture()
        self.assertFalse((self.root / "capture").exists())
        self.assertFalse(list(self.root.glob(".sqlite-migration-*")))

    def test_missing_projection_is_explicit_and_requires_rebuild(self):
        (self.data / "client-history/partner-activity.sqlite").unlink()
        result = self.capture()
        self.assertEqual(set(result["databases"]), migration.EXPECTED)
        self.assertEqual(result["databases"]["partner_activity"]["status"], "missing_rebuild_required")

    def test_mismatched_activation_pair_refuses_publication(self):
        report = self.data / "activations/current/activation-report.sqlite"
        with closing(sqlite3.connect(report)) as c:
            c.execute("UPDATE report_meta SET value='stale-generation' WHERE key='sourceGeneration'")
            c.commit()
        with self.assertRaisesRegex(migration.MigrationError, "generations differ"):
            self.capture()
        self.assertFalse((self.root / "capture").exists())

    def test_concurrent_source_commit_fails_quiescent_capture(self):
        original = migration.copy_database
        changed = False
        def copy_and_write(*args, **kwargs):
            nonlocal changed
            result = original(*args, **kwargs)
            if not changed:
                with closing(sqlite3.connect(self.data / "sales.sqlite")) as c:
                    c.execute("UPDATE sample SET value='new-commit'")
                    c.commit()
                changed = True
            return result
        with patch.object(migration, "copy_database", copy_and_write):
            with self.assertRaisesRegex(migration.MigrationError, "committed writes"):
                self.capture()
        self.assertFalse((self.root / "capture").exists())
        self.assertFalse(list(self.root.glob(".sqlite-migration-*")))

    def test_per_database_mode_does_not_claim_cross_database_consistency(self):
        result = self.capture(consistency="per-database")
        self.assertFalse(result["cross_database_consistency_verified"])
        self.assertFalse(result["production_cutover_ready"])

    def test_generation_replacement_is_detected_even_if_writer_ignores_lock(self):
        original = migration.copy_database
        changed = False
        def copy_and_replace(*args, **kwargs):
            nonlocal changed
            result = original(*args, **kwargs)
            if not changed:
                base = self.data / "activations"
                other = base / "generations/other-generation"
                other.mkdir()
                pointer = base / "current"
                pointer.unlink()
                pointer.symlink_to("generations/other-generation")
                changed = True
            return result
        with patch.object(migration, "copy_database", copy_and_replace):
            with self.assertRaisesRegex(migration.MigrationError, "Publication changed"):
                self.capture()
        self.assertFalse((self.root / "capture").exists())

    def test_symlink_principal_refused(self):
        source = self.data / "sales.sqlite"
        target = self.data / "other.sqlite"
        source.rename(target)
        source.symlink_to(target.name)
        with self.assertRaisesRegex(migration.MigrationError, "non-symlink"):
            self.capture()

    def test_scope_budget_failure_cleans_staging(self):
        with self.assertRaisesRegex(migration.MigrationError, "byte budget"):
            migration.snapshot(self.data, None, self.root / "capture", REVISION, max_bytes=1, min_free_bytes=0)
        self.assertFalse(list(self.root.glob(".sqlite-migration-*")))

    def test_existing_directory_and_evidence_preserved(self):
        path = self.root / "existing"
        path.mkdir()
        with self.assertRaises((OSError, migration.MigrationError)):
            self.capture("existing")
        stage = self.root / "stage"
        stage.mkdir()
        with self.assertRaises(OSError):
            migration.publish_directory(stage, path)
        self.assertTrue(stage.exists())
        marker = self.root / "evidence.json"
        migration.publish_json(marker, {"status": "old-valid"})
        with self.assertRaises(FileExistsError):
            migration.publish_json(marker, {"status": "new"})
        self.assertEqual(json.loads(marker.read_text())["status"], "old-valid")

    def test_row_fingerprint_is_order_independent_but_duplicate_and_type_sensitive(self):
        db = self.root / "rows.sqlite"
        create_database(db, "CREATE TABLE values_table(value);")
        scratch = self.root / "hashes"
        scratch.mkdir()
        with closing(sqlite3.connect(db)) as c:
            rows = [(i,) for i in range(80)] + [("one",), (None,), (b"blob",), (1.5,)]
            c.executemany("INSERT INTO values_table VALUES(?)", rows)
            c.commit()
            one = migration.sorted_row_fingerprint(c, "values_table", scratch, chunk_rows=1,
                                                   deadline=time.monotonic() + 30, min_free_bytes=0)
            c.execute("DELETE FROM values_table")
            c.executemany("INSERT INTO values_table VALUES(?)", reversed(rows))
            c.commit()
            two = migration.sorted_row_fingerprint(c, "values_table", scratch, chunk_rows=100,
                                                   deadline=time.monotonic() + 30, min_free_bytes=0)
            self.assertEqual(one, two)
            c.execute("INSERT INTO values_table VALUES(1)")
            three = migration.sorted_row_fingerprint(c, "values_table", scratch, chunk_rows=4,
                                                     deadline=time.monotonic() + 30, min_free_bytes=0)
            self.assertNotEqual(one["sorted_row_sha256"], three["sorted_row_sha256"])
        self.assertNotEqual(migration.row_digest((1,)), migration.row_digest(("1",)))
        self.assertNotEqual(migration.row_digest(("ab", "c")), migration.row_digest(("a", "bc")))
        self.assertFalse(list(scratch.iterdir()))

    def test_full_scope_fingerprint_and_tamper_rejection(self):
        self.capture()
        result = migration.fingerprint(self.root / "capture", min_free_bytes=0)
        self.assertEqual(len(result["databases"]), 10)
        self.assertFalse(result["application_query_parity_verified"])
        with closing(sqlite3.connect(self.root / "capture/sales.sqlite")) as c:
            c.execute("UPDATE sample SET value='different'")
            c.commit()
        with self.assertRaisesRegex(migration.MigrationError, "checksum differs"):
            migration.fingerprint(self.root / "capture", min_free_bytes=0)
        self.assertFalse(list((self.root / "capture").glob(".fingerprints-*")))


if __name__ == "__main__":
    unittest.main()
