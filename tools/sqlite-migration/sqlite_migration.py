#!/usr/bin/env python3
"""Offline SQLite migration evidence. No PostgreSQL cutover or live app changes.

Inventory reads catalogs only. Snapshot copies the complete configured database
scope and pins supported activation publications. Fingerprint reads only a
sealed snapshot, with bounded memory and no row values in the result.
"""
from __future__ import annotations

import argparse
import ctypes
from contextlib import ExitStack, closing, contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
import fcntl
import hashlib
import heapq
import json
import math
import os
from pathlib import Path
import re
import shutil
import sqlite3
import stat
import struct
import tempfile
import time

FORMAT = "comenzi-sqlite-migration-v1"
RESERVE = 40 * 1024 ** 3
MAX_METADATA_ROWS = 10000
EXPECTED = frozenset(("application", "sales", "usage", "history", "vodafone_ledger",
                      "vodafone_report", "digi_ledger", "digi_report",
                      "partner_activity", "vodafone_focus"))


class MigrationError(RuntimeError):
    pass


def require(condition, message):
    if not condition:
        raise MigrationError(message)


def now():
    return datetime.now(timezone.utc).isoformat()


def json_bytes(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"),
                      allow_nan=False).encode("utf-8")


def digest(path):
    with regular_file(path) as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def identity(path):
    info = Path(path).lstat()
    require(stat.S_ISREG(info.st_mode), "Source must be a regular non-symlink file")
    return (info.st_dev, info.st_ino)


@contextmanager
def regular_file(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as stream:
        require(stat.S_ISREG(os.fstat(fd).st_mode), "Expected a regular file")
        yield stream


def sql_identifier(name):
    return '"' + name.replace('"', '""') + '"'


def read_json(path, limit=32 * 1024 ** 2):
    with regular_file(path) as stream:
        raw = stream.read(limit + 1)
    require(len(raw) <= limit, "Metadata exceeds its bounded size")
    return json.loads(raw)


def publish_json(path, value):
    """New output only: never replace a previously valid evidence file."""
    path = Path(path)
    require(path.parent.is_dir(), "Output parent must already exist")
    fd, name = tempfile.mkstemp(prefix=".migration-evidence-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(json_bytes(value) + b"\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.link(name, path)  # Refuses an existing path, including a symlink.
        fsync_directory(path.parent)
    finally:
        Path(name).unlink(missing_ok=True)


def fsync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def publish_directory(source, destination):
    """Linux atomic, no-replace publication, including a concurrent empty directory."""
    libc = ctypes.CDLL(None, use_errno=True)
    rename = libc.renameat2
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    if rename(-100, os.fsencode(source), -100, os.fsencode(destination), 1):
        raise OSError(ctypes.get_errno(), "Snapshot publication refused")


def local_filesystem(path):
    """Reject network filesystems even when the caller supplied a local-looking path."""
    path = Path(path).resolve(strict=True)
    mounts = []
    for line in Path("/proc/self/mountinfo").read_text().splitlines():
        before, after = line.split(" - ", 1)
        mount = re.sub(r"\\([0-7]{3})", lambda m: chr(int(m[1], 8)), before.split()[4])
        if path == Path(mount) or path.is_relative_to(mount):
            mounts.append((len(mount), after.split()[0]))
    require(bool(mounts), "Cannot identify the input filesystem")
    fs = max(mounts)[1]
    require(fs not in {"cifs", "smb3", "nfs", "nfs4", "9p", "ceph", "glusterfs"}
            and not fs.startswith("fuse."), "SQLite work requires a local filesystem")


@dataclass(frozen=True)
class Database:
    key: str
    path: Path
    kind: str = "authoritative"


def pin_generation(base):
    base = Path(base)
    require(base.is_dir() and not base.is_symlink(), "Activation root must be a directory")
    pointer = base / "current"
    require(pointer.is_symlink(), "Expected a published activation generation")
    generations = base / "generations"
    require(generations.is_dir() and not generations.is_symlink(), "Invalid generations root")
    target = pointer.resolve(strict=True)
    require(target.is_dir() and target.parent == generations.resolve(), "Invalid generation target")
    return {"pointer": pointer, "target": target, "link": os.readlink(pointer)}


@contextmanager
def scope(data_root, activation_root=None):
    root = Path(data_root).resolve(strict=True)
    activations = Path(activation_root).resolve(strict=True) if activation_root else root / "activations"
    local_filesystem(root)
    local_filesystem(activations)
    with ExitStack() as stack:
        pins = {}
        # Same order and shared flock protocol as deploy/backup.py. Do not create
        # a missing lock file and thereby invent a publication protocol.
        for provider, base in (("vodafone", activations), ("digi", activations / "digi")):
            fd = os.open(base / ".activation-job.lock", os.O_RDONLY | os.O_NOFOLLOW)
            stack.callback(os.close, fd)
            require(stat.S_ISREG(os.fstat(fd).st_mode), "Publication lock is not regular")
            fcntl.flock(fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
            pins[provider] = pin_generation(base)
        databases = [Database("application", root / "mobiup.sqlite"),
                     Database("sales", root / "sales.sqlite"),
                     Database("usage", root / "usage.sqlite"),
                     Database("history", root / "client-history/client-sales-history.sqlite")]
        for provider, pin in pins.items():
            databases += [Database(provider + "_ledger", pin["target"] / "activations.sqlite"),
                          Database(provider + "_report", pin["target"] / "activation-report.sqlite")]
        databases += [Database("partner_activity", root / "client-history/partner-activity.sqlite", "derived"),
                      Database("vodafone_focus", pins["vodafone"]["target"] / "vodafone-focus-evidence.sqlite", "derived")]
        require({d.key for d in databases} == EXPECTED, "Incomplete migration scope")
        for database in databases:
            if not database.path.exists() and not database.path.is_symlink() and database.kind == "derived":
                continue
            local_filesystem(database.path)
            identity(database.path)
            resolved = database.path.resolve(strict=True)
            require(resolved == database.path, "Unexpected symlink inside database path")
        yield databases, pins
        for pin in pins.values():
            require(pin["pointer"].is_symlink() and os.readlink(pin["pointer"]) == pin["link"]
                    and pin["pointer"].resolve(strict=True) == pin["target"], "Publication changed during capture")


@contextmanager
def read_database(path, deadline):
    before = identity(path)
    with closing(sqlite3.connect(Path(path).as_uri() + "?mode=ro", uri=True, timeout=1)) as connection:
        require(identity(path) == before, "Database replaced during open")
        connection.execute("PRAGMA query_only=ON")
        connection.execute("PRAGMA busy_timeout=1000")
        connection.setlimit(sqlite3.SQLITE_LIMIT_LENGTH, 16 * 1024 ** 2)
        connection.set_progress_handler(lambda: int(time.monotonic() > deadline), 10000)
        yield connection
        require(identity(path) == before, "Database replaced while open")


def bounded_rows(connection, query, args=()):
    rows = connection.execute(query, args).fetchmany(MAX_METADATA_ROWS + 1)
    require(len(rows) <= MAX_METADATA_ROWS, "Catalog scope exceeds the metadata limit")
    return rows


def table_exists(connection, table):
    return connection.execute("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?", (table,)).fetchone() is not None


def activation_pair(ledger, report):
    source = dict(bounded_rows(ledger, "SELECT key,value FROM activation_meta"))
    target = dict(bounded_rows(report, "SELECT key,value FROM report_meta"))
    require(source.get("schema_version") == "3", "Activation schema needs a separate compatibility procedure")
    require(bool(source.get("generation")) and source["generation"] == target.get("sourceGeneration"),
            "Activation ledger/report generations differ")
    imports = bounded_rows(ledger, "SELECT sha256,operator,row_count,parser_version FROM activation_imports WHERE status='complete' ORDER BY sha256")
    encoded = json.dumps(imports, separators=(",", ":"))
    require(encoded == target.get("sourceImports"), "Activation report does not match its ledger imports")
    return {"generation": source["generation"], "source_import_count": len(imports),
            "source_imports_sha256": hashlib.sha256(encoded.encode()).hexdigest(), "pair_validated": True}


def catalog(connection):
    objects = bounded_rows(connection, "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name")
    tables = []
    blockers = []
    mapping = {"INTEGER": "bigint", "INT": "bigint", "TEXT": "text", "REAL": "double precision", "BLOB": "bytea"}
    for kind, name, table, ddl in objects:
        if kind == "trigger":
            blockers.append({"object": name, "reason": "trigger_requires_transaction_and_revision_port"})
        if ddl and re.search(r"\b(?:AUTOINCREMENT|GLOB|WITHOUT\s+ROWID|COLLATE\s+NOCASE|CREATE\s+VIRTUAL)\b", ddl, re.I):
            blockers.append({"object": name, "reason": "sqlite_ddl_semantics_require_review"})
        if kind != "table":
            continue
        columns = bounded_rows(connection, "PRAGMA table_xinfo(" + sql_identifier(name) + ")")
        indexes = bounded_rows(connection, "PRAGMA index_list(" + sql_identifier(name) + ")")
        foreign_keys = bounded_rows(connection, "PRAGMA foreign_key_list(" + sql_identifier(name) + ")")
        candidates = []
        for cid, column, declared, not_null, default, primary_key, hidden in columns:
            candidates.append({"name": column, "declared_type": declared, "not_null": bool(not_null),
                               "default": default, "primary_key_ordinal": primary_key, "hidden": hidden,
                               "candidate_postgresql_type": mapping.get(declared.upper())})
            if declared.upper() not in mapping or hidden:
                blockers.append({"object": name + "." + column, "reason": "type_or_generated_column_requires_review"})
            if primary_key and not not_null and declared.upper() != "INTEGER":
                blockers.append({"object": name + "." + column, "reason": "sqlite_nullable_primary_key_requires_data_check"})
        tables.append({"name": name, "columns": candidates, "indexes": indexes, "foreign_keys": foreign_keys})
    sequences = bounded_rows(connection, "SELECT name,seq FROM sqlite_sequence ORDER BY name") if table_exists(connection, "sqlite_sequence") else []
    result = {"objects": objects, "tables": tables, "sqlite_sequences": sequences,
              "portability_blockers": blockers, "automatic_schema_conversion_verified": False}
    result["catalog_sha256"] = hashlib.sha256(json_bytes(result)).hexdigest()
    return result


def inventory(data_root, activation_root, source_revision, deadline_seconds=60):
    require(deadline_seconds > 0, "Inventory time budget must be positive")
    deadline = time.monotonic() + deadline_seconds
    result = {"format": FORMAT, "kind": "catalog_inventory", "at": now(), "source_revision": source_revision,
              "business_rows_read": False, "catalog_and_publication_metadata_only": True,
              "cross_database_consistency_verified": False, "databases": {}}
    with scope(data_root, activation_root) as (databases, pins), ExitStack() as stack:
        opened = {}
        for database in databases:
            if not database.path.exists() and database.kind == "derived":
                result["databases"][database.key] = {"kind": database.kind, "status": "missing_rebuild_required"}
                continue
            c = stack.enter_context(read_database(database.path, deadline))
            c.execute("BEGIN")
            opened[database.key] = c
            result["databases"][database.key] = {"kind": database.kind, "status": "catalog_read", "path": str(database.path),
                "allocated_database_bytes": c.execute("PRAGMA page_count").fetchone()[0] * c.execute("PRAGMA page_size").fetchone()[0],
                "catalog": catalog(c)}
        result["activation_pairs"] = {p: activation_pair(opened[p + "_ledger"], opened[p + "_report"]) for p in pins}
    return result


def copy_database(source, destination, *, deadline, max_bytes, min_free_bytes):
    page_size = source.execute("PRAGMA page_size").fetchone()[0]
    def progress(status, remaining, total):
        require(time.monotonic() <= deadline, "Snapshot time budget exceeded")
        require(total * page_size <= max_bytes, "Snapshot exceeded its byte budget")
        require(shutil.disk_usage(destination.parent).free >= min_free_bytes, "Storage reserve exhausted")
    with closing(sqlite3.connect(destination)) as target:
        os.chmod(destination, 0o600)
        source.backup(target, pages=256, progress=progress, sleep=0.05)
        target.execute("PRAGMA journal_mode=DELETE")
        target.set_progress_handler(lambda: int(time.monotonic() > deadline), 10000)
        require(target.execute("PRAGMA quick_check(1)").fetchall() == [("ok",)], "Snapshot structural check failed")
        require(target.execute("PRAGMA foreign_key_check").fetchone() is None, "Snapshot foreign key check failed")
    require(not Path(str(destination) + "-wal").exists(), "Snapshot still depends on a WAL file")
    with destination.open("rb") as stream:
        os.fsync(stream.fileno())


def snapshot(data_root, activation_root, output_dir, source_revision, *, consistency="quiescent",
             max_bytes, min_free_bytes=RESERVE, deadline_seconds=1800):
    require(consistency in {"quiescent", "per-database"}, "Unsupported consistency mode")
    require(max_bytes > 0 and min_free_bytes >= 0 and deadline_seconds > 0, "Invalid resource budget")
    deadline = time.monotonic() + deadline_seconds
    output = Path(output_dir).absolute()
    require(output.parent.is_dir() and not output.exists() and not output.is_symlink(), "A new output directory is required")
    require("backups" not in output.parts, "Migration copies belong in scratch, not long-term backups")
    local_filesystem(output.parent)
    root = Path(data_root).resolve(strict=True)
    activation = Path(activation_root).resolve(strict=True) if activation_root else root / "activations"
    for source in (root, activation):
        require(not output.resolve().is_relative_to(source) and not source.is_relative_to(output.resolve()),
                "Output and live input trees must be separate")
    staging = Path(tempfile.mkdtemp(prefix=".sqlite-migration-", dir=output.parent))
    os.chmod(staging, 0o700)
    result = {"format": FORMAT, "kind": "snapshot", "at": now(), "source_revision": source_revision,
              "sqlite_version": sqlite3.sqlite_version, "requested_consistency": consistency,
              "cross_database_consistency_verified": False, "production_cutover_ready": False,
              "databases": {}, "derived_policy": "reference_only; rebuild and compare after engine conversion"}
    try:
        with scope(root, activation) as (databases, pins), ExitStack() as stack:
            opened = {}
            observed = {}
            for database in databases:
                if not database.path.exists() and database.kind == "derived":
                    result["databases"][database.key] = {"kind": "derived", "status": "missing_rebuild_required"}
                    continue
                c = stack.enter_context(read_database(database.path, deadline))
                opened[database.key] = c
                observed[database.key] = c.execute("PRAGMA data_version").fetchone()[0]
            # All data_version baselines precede every pinned read snapshot.
            sizes = {}
            for key, c in opened.items():
                c.execute("BEGIN")
                c.execute("SELECT count(*) FROM sqlite_schema").fetchone()
                sizes[key] = c.execute("PRAGMA page_count").fetchone()[0] * c.execute("PRAGMA page_size").fetchone()[0]
            projected = sum(sizes.values()) + 64 * 1024 ** 2
            require(projected <= max_bytes, "Complete scope exceeds the declared byte budget")
            require(shutil.disk_usage(staging).free - projected >= min_free_bytes, "Insufficient space after complete snapshot growth")
            for database in databases:
                if database.key not in opened:
                    continue
                key = database.key
                path = staging / (key + ".sqlite")
                copy_database(opened[key], path, deadline=deadline, max_bytes=sizes[key], min_free_bytes=min_free_bytes)
                with read_database(path, deadline) as copied:
                    metadata = catalog(copied)
                result["databases"][key] = {"kind": database.kind, "status": "copied", "file": path.name,
                    "bytes": path.stat().st_size, "sha256": digest(path), "catalog": metadata}
            # Validate the actual copies, not just the live sources.
            with ExitStack() as copied:
                connections = {k: copied.enter_context(read_database(staging / (k + ".sqlite"), deadline))
                               for k in opened if k.endswith(("_ledger", "_report"))}
                result["activation_pairs"] = {p: activation_pair(connections[p + "_ledger"], connections[p + "_report"]) for p in pins}
            for c in opened.values():
                c.rollback()
            changed = [k for k, c in opened.items() if c.execute("PRAGMA data_version").fetchone()[0] != observed[k]]
            result["sources_with_concurrent_commits"] = changed
            if consistency == "quiescent":
                require(not changed, "Sources committed writes during the requested quiescent snapshot")
                result["cross_database_consistency_verified"] = True
            result["captured_at"] = now()
        require(time.monotonic() <= deadline, "Snapshot time budget exceeded")
        publish_json(staging / "manifest.json", result)
        # Same filesystem publication. Fail rather than replacing any prior result.
        require(not output.exists() and not output.is_symlink(), "Output appeared during capture")
        publish_directory(staging, output)
        fsync_directory(output.parent)
        return result
    finally:
        if staging.exists():
            shutil.rmtree(staging)


def encode_cell(value):
    if value is None:
        return b"n"
    if isinstance(value, int):
        return b"i" + str(value).encode("ascii")
    if isinstance(value, float):
        require(math.isfinite(value), "Non-finite real requires an explicit conversion rule")
        return b"r" + struct.pack(">d", value)
    if isinstance(value, str):
        return b"t" + value.encode("utf-8")
    if isinstance(value, bytes):
        return b"b" + value
    raise MigrationError("Unsupported cell storage type")


def row_digest(row):
    result = hashlib.sha256()
    for value in row:
        payload = encode_cell(value)
        result.update(len(payload).to_bytes(8, "big"))
        result.update(payload)
    return result.hexdigest()


def sorted_row_fingerprint(connection, table, scratch, *, chunk_rows=50000, deadline, min_free_bytes=RESERVE):
    require(0 < chunk_rows <= 100000 and min_free_bytes >= 0, "Invalid fingerprint resource budget")
    columns = [r[1] for r in connection.execute("PRAGMA table_xinfo(" + sql_identifier(table) + ")") if r[6] != 1]
    query = "SELECT " + ",".join(map(sql_identifier, columns)) + " FROM " + sql_identifier(table)
    chunks = []
    count = 0
    with closing(connection.execute(query)) as cursor:
        hashes = []
        for row in cursor:
            require(time.monotonic() <= deadline, "Fingerprint time budget exceeded")
            hashes.append(row_digest(row))
            count += 1
            if len(hashes) == chunk_rows:
                require(shutil.disk_usage(scratch).free - len(hashes) * 65 >= min_free_bytes, "Fingerprint storage reserve exhausted")
                path = scratch / (str(len(chunks)) + ".hashes")
                path.write_bytes(("\n".join(sorted(hashes)) + "\n").encode("ascii"))
                os.chmod(path, 0o600)
                chunks.append(path)
                hashes = []
        if hashes:
            require(shutil.disk_usage(scratch).free - len(hashes) * 65 >= min_free_bytes, "Fingerprint storage reserve exhausted")
            path = scratch / (str(len(chunks)) + ".hashes")
            path.write_bytes(("\n".join(sorted(hashes)) + "\n").encode("ascii"))
            os.chmod(path, 0o600)
            chunks.append(path)
    # Limit open file descriptors for large tables, preserving duplicate hashes.
    pass_number = 0
    while len(chunks) > 64:
        merged = []
        for offset in range(0, len(chunks), 64):
            group = chunks[offset:offset + 64]
            require(time.monotonic() <= deadline, "Fingerprint time budget exceeded")
            needed = sum(path.stat().st_size for path in group)
            require(shutil.disk_usage(scratch).free - needed >= min_free_bytes, "Fingerprint merge reserve exhausted")
            path = scratch / f"merge-{pass_number}-{offset}.hashes"
            with ExitStack() as stack, path.open("xb") as output:
                os.chmod(path, 0o600)
                files = [stack.enter_context(p.open("rb")) for p in group]
                for value in heapq.merge(*files):
                    output.write(value)
            for old in group:
                old.unlink()
            merged.append(path)
        chunks = merged
        pass_number += 1
    checksum = hashlib.sha256()
    with ExitStack() as stack:
        files = [stack.enter_context(path.open("rb")) for path in chunks]
        for value in heapq.merge(*files):
            require(time.monotonic() <= deadline, "Fingerprint time budget exceeded")
            checksum.update(value)
    for path in chunks:
        path.unlink()
    return {"columns": columns, "rows": count, "sorted_row_sha256": checksum.hexdigest()}


def fingerprint(snapshot_dir, *, deadline_seconds=1800, chunk_rows=50000, min_free_bytes=RESERVE):
    require(deadline_seconds > 0 and 0 < chunk_rows <= 100000 and min_free_bytes >= 0, "Invalid fingerprint resource budget")
    root = Path(snapshot_dir).resolve(strict=True)
    local_filesystem(root)
    manifest = read_json(root / "manifest.json")
    require(manifest.get("format") == FORMAT and manifest.get("kind") == "snapshot", "Not a supported migration snapshot")
    require(set(manifest["databases"]) == EXPECTED, "Snapshot scope differs from the full migration contract")
    deadline = time.monotonic() + deadline_seconds
    result = {"format": FORMAT, "kind": "row_fingerprints", "source_revision": manifest["source_revision"],
              "encoding": "typed-length-sha256-sorted-v1", "manifest_sha256": digest(root / "manifest.json"), "databases": {}}
    with tempfile.TemporaryDirectory(prefix=".fingerprints-", dir=root) as tmp:
        scratch = Path(tmp)
        for key, record in manifest["databases"].items():
            if record["status"] == "missing_rebuild_required":
                result["databases"][key] = {"status": record["status"]}
                continue
            require(record.get("file") == key + ".sqlite", "Unexpected snapshot filename")
            path = root / record["file"]
            identity(path)
            require(digest(path) == record["sha256"], "Snapshot checksum differs from its manifest")
            with read_database(path, deadline) as c:
                c.execute("BEGIN")
                tables = [r[0] for r in bounded_rows(c, "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
                result["databases"][key] = {"status": "fingerprinted", "tables": {
                    table: sorted_row_fingerprint(c, table, scratch, chunk_rows=chunk_rows, deadline=deadline,
                                                  min_free_bytes=min_free_bytes) for table in tables}}
            require(digest(path) == record["sha256"], "Snapshot changed during fingerprint")
    result["completed_at"] = now()
    result["application_query_parity_verified"] = False
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    for command in ("inventory", "snapshot"):
        p = sub.add_parser(command)
        p.add_argument("--data-root", required=True, type=Path)
        p.add_argument("--activation-root", type=Path)
        p.add_argument("--source-revision", required=True)
        p.add_argument("--deadline-seconds", type=int, default=60 if command == "inventory" else 1800)
    sub.choices["inventory"].add_argument("--output", required=True, type=Path)
    p = sub.choices["snapshot"]
    p.add_argument("--output-dir", required=True, type=Path)
    p.add_argument("--consistency", choices=("quiescent", "per-database"), default="quiescent")
    p.add_argument("--max-bytes", required=True, type=int)
    p.add_argument("--min-free-bytes", type=int, default=RESERVE)
    p = sub.add_parser("fingerprint")
    p.add_argument("--snapshot-dir", required=True, type=Path)
    p.add_argument("--output", required=True, type=Path)
    p.add_argument("--deadline-seconds", type=int, default=1800)
    p.add_argument("--chunk-rows", type=int, default=50000)
    p.add_argument("--min-free-bytes", type=int, default=RESERVE)
    args = vars(parser.parse_args(argv))
    command = args.pop("command")
    if "source_revision" in args:
        require(bool(re.fullmatch(r"[0-9a-f]{40}", args["source_revision"])), "A full source revision is required")
    output = args.pop("output", None)
    result = {"inventory": inventory, "snapshot": snapshot, "fingerprint": fingerprint}[command](**args)
    if output is not None:
        publish_json(output, result)
    print(json.dumps({"status": "completed", "operation": command, "database_count": len(result["databases"]),
                      "cross_database_consistency_verified": result.get("cross_database_consistency_verified", False),
                      "production_cutover_ready": False}))


if __name__ == "__main__":
    try:
        main()
    except (MigrationError, OSError, sqlite3.Error, ValueError) as error:
        # Do not echo SQL, row values, connection strings or private paths.
        print(json.dumps({"status": "failed", "error_class": type(error).__name__,
                          "reason": str(error) if isinstance(error, MigrationError) else "Input, storage or SQLite operation failed",
                          "production_cutover_ready": False}))
        raise SystemExit(1)
