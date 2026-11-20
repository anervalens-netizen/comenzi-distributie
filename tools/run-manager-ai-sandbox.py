"""Trusted worker entrypoint. Run only inside the manager AI Bubblewrap namespace."""

import base64
from contextlib import closing
import csv
import ctypes
import errno
import itertools
import json
import math
import os
from pathlib import Path
import resource
import sqlite3
import stat
import subprocess
import sys
import tempfile
import unicodedata


MAX_ARTIFACT_BYTES = 2 * 1024 * 1024
MAX_TOTAL_BYTES = 4 * 1024 * 1024
MAX_FILE_COUNT = 4
MAX_LOG_BYTES = 16 * 1024
MAX_SQL_ROWS = 2000
MAX_SQL_PREVIEW = 60
MAX_PREVIEW_BYTES = 24 * 1024
OUTPUT_FORMATS = frozenset((".csv", ".tsv", ".xlsx", ".json", ".txt", ".md", ".png"))


def constrain():
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_AS, (384 * 1024 * 1024, 384 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_CPU, (8, 9))
    resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_ARTIFACT_BYTES, MAX_ARTIFACT_BYTES))
    resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
    libc = ctypes.CDLL(None, use_errno=True)
    libc.prctl.argtypes = (ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong)
    # Protect the worker's host stdout pipe and file descriptors from the code process.
    if libc.prctl(4, 0, 0, 0, 0) != 0:  # PR_SET_DUMPABLE
        raise RuntimeError("worker process protection unavailable")


def restricted_child():
    """Fail closed if the child cannot install the kernel syscall filter."""
    seccomp = ctypes.CDLL("libseccomp.so.2")
    seccomp.seccomp_init.argtypes = (ctypes.c_uint32,)
    seccomp.seccomp_init.restype = ctypes.c_void_p
    seccomp.seccomp_syscall_resolve_name.argtypes = (ctypes.c_char_p,)
    seccomp.seccomp_rule_add.argtypes = (ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint)
    seccomp.seccomp_load.argtypes = (ctypes.c_void_p,)
    seccomp.seccomp_release.argtypes = (ctypes.c_void_p,)
    policy = seccomp.seccomp_init(0x7FFF0000)  # SCMP_ACT_ALLOW
    if not policy:
        raise RuntimeError("sandbox filter unavailable")
    blocked = (
        # No descendants or network, including local sockets.
        b"clone", b"clone3", b"fork", b"vfork", b"socket", b"socketpair", b"socketcall",
        # Block cross-process, namespace, kernel and asynchronous I/O interfaces.
        b"ptrace", b"process_vm_readv", b"process_vm_writev", b"pidfd_getfd", b"pidfd_open",
        b"pidfd_send_signal", b"unshare", b"setns", b"mount", b"umount2", b"pivot_root",
        b"fsopen", b"fsconfig", b"fsmount", b"open_tree", b"move_mount", b"mount_setattr",
        b"bpf", b"perf_event_open", b"keyctl", b"add_key", b"request_key",
        b"io_uring_setup", b"io_uring_enter", b"io_uring_register",
    )
    try:
        error_action = 0x00050000 | errno.EPERM  # SCMP_ACT_ERRNO
        for name in blocked:
            number = seccomp.seccomp_syscall_resolve_name(name)
            if number >= 0 and seccomp.seccomp_rule_add(policy, error_action, number, 0) != 0:
                raise RuntimeError("sandbox filter rule unavailable")
        if seccomp.seccomp_load(policy) != 0:
            raise RuntimeError("sandbox filter activation failed")
    finally:
        seccomp.seccomp_release(policy)


def run_python():
    with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
        script = subprocess.Popen(
            [sys.executable, "-IB", "/input/program.py"],
            stdin=subprocess.DEVNULL,
            stdout=stdout,
            stderr=stderr,
            close_fds=True,
            preexec_fn=restricted_child,
        )
        try:
            code = script.wait(timeout=14)
        except subprocess.TimeoutExpired:
            script.kill()
            script.wait()
            code = 124
        stdout.seek(0)
        stderr.seek(0)
        return {
            "exitCode": code,
            "stdout": stdout.read(MAX_LOG_BYTES).decode("utf-8", "replace"),
            "stderr": stderr.read(MAX_LOG_BYTES).decode("utf-8", "replace"),
        }


def permit_sql(action, name, detail, database, _):
    if action in (sqlite3.SQLITE_SELECT, sqlite3.SQLITE_RECURSIVE):
        return sqlite3.SQLITE_OK
    if action == sqlite3.SQLITE_READ and database == "main" and name and not name.startswith("pragma_"):
        return sqlite3.SQLITE_OK
    if action == sqlite3.SQLITE_FUNCTION and str(detail).lower() not in {
        "load_extension", "fts3_tokenizer", "readfile", "writefile", "eval",
    }:
        return sqlite3.SQLITE_OK
    return sqlite3.SQLITE_DENY


def preview_cell(value, limit):
    if isinstance(value, bytes):
        return f"[BLOB, {len(value)} octeți]", True
    if isinstance(value, float) and not math.isfinite(value):
        return None, True
    if isinstance(value, int) and abs(value) > (1 << 53) - 1:
        return str(value), False
    if isinstance(value, str) and len(value) > limit:
        return value[:limit], True
    return value, False


def run_sql():
    if not Path("/input/data.sqlite").is_file():
        return {"exitCode": 1, "stdout": "", "stderr": "Lipsește baza de date autorizată."}
    query = Path("/input/program.sql").read_text(encoding="utf-8")
    connection = sqlite3.connect("file:/input/data.sqlite?mode=ro&immutable=1", uri=True)
    with closing(connection):
        connection.setlimit(sqlite3.SQLITE_LIMIT_LENGTH, 1024 * 1024)
        connection.setlimit(sqlite3.SQLITE_LIMIT_COLUMN, 64)
        connection.setlimit(sqlite3.SQLITE_LIMIT_VARIABLE_NUMBER, 0)
        connection.setlimit(sqlite3.SQLITE_LIMIT_ATTACHED, 0)
        connection.setlimit(sqlite3.SQLITE_LIMIT_LIKE_PATTERN_LENGTH, 1024)
        connection.execute("PRAGMA query_only=ON")
        connection.execute("PRAGMA trusted_schema=OFF")
        connection.execute("PRAGMA temp_store=MEMORY")
        connection.set_authorizer(permit_sql)
        operations = 0

        def exhausted():
            nonlocal operations
            operations += 10_000
            return operations > 40_000_000

        connection.set_progress_handler(exhausted, 10_000)
        try:
            cursor = connection.execute(query)
            if not cursor.description:
                return {"exitCode": 1, "stdout": "", "stderr": "Este necesară o interogare SELECT."}
            columns = [value[0][:128] for value in cursor.description]
            preview = []
            body_bytes = 0
            export_bytes = 0
            clipped = any(len(value[0]) > 128 for value in cursor.description)
            total = 0
            with open("/output/rezultat-sql.csv", "w", encoding="utf-8", newline="") as output:
                writer = csv.writer(output)
                writer.writerow(columns)
                for row in itertools.islice(cursor, MAX_SQL_ROWS + 1):
                    if total == MAX_SQL_ROWS:
                        clipped = True
                        break
                    cells = [preview_cell(value, 2048) for value in row]
                    values = [value for value, _ in cells]
                    clipped |= any(was_clipped for _, was_clipped in cells)
                    encoded_size = len(json.dumps(values, ensure_ascii=True))
                    # The worst CSV escaping is below this conservative JSON budget.
                    if export_bytes + encoded_size > MAX_ARTIFACT_BYTES // 2:
                        clipped = True
                        break
                    writer.writerow(values)
                    export_bytes += encoded_size
                    total += 1
                    if len(preview) < MAX_SQL_PREVIEW and body_bytes + encoded_size <= MAX_PREVIEW_BYTES:
                        preview.append(values)
                        body_bytes += encoded_size
            return {
                "exitCode": 0,
                "stdout": "",
                "stderr": "",
                "rows": {
                    "columns": columns,
                    "rows": preview,
                    "truncated": clipped or total > len(preview),
                    "exportTruncated": clipped,
                    "exportedRows": total,
                },
            }
        except sqlite3.Error as error:
            return {"exitCode": 1, "stdout": "", "stderr": str(error)[:2048]}


def artifact_name(name):
    name = unicodedata.normalize("NFC", name)
    valid = (
        len(name) <= 112 and name[:1].isalnum()
        and all(character.isalnum() or character in " ._()-" for character in name)
        and Path(name).suffix.lower() in OUTPUT_FORMATS
    )
    return name if valid else None


def harvest():
    artifacts = []
    skipped = 0
    total = 0
    directory = os.open("/output", os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        with os.scandir(directory) as entries:
            names = [entry.name for entry in itertools.islice(entries, 65)]
        if len(names) == 65:
            return [], 65
        for original in sorted(names):
            name = artifact_name(original)
            if not name or len(artifacts) >= MAX_FILE_COUNT:
                skipped += 1
                continue
            file = None
            try:
                file = os.open(original, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
                info = os.fstat(file)
                if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or not info.st_size
                        or info.st_size > MAX_ARTIFACT_BYTES or total + info.st_size > MAX_TOTAL_BYTES):
                    skipped += 1
                    continue
                with os.fdopen(file, "rb", closefd=False) as stream:
                    data = stream.read(MAX_ARTIFACT_BYTES + 1)
                if len(data) != info.st_size:
                    skipped += 1
                    continue
                total += len(data)
                artifacts.append({"filename": name, "data": base64.b64encode(data).decode("ascii")})
            except OSError:
                skipped += 1
            finally:
                if file is not None:
                    os.close(file)
    finally:
        os.close(directory)
    return artifacts, skipped


def main():
    constrain()
    mode = sys.argv[1]
    if mode == "python":
        result = run_python()
    elif mode == "sql":
        result = run_sql()
    else:
        raise ValueError("invalid sandbox mode")
    artifacts, skipped = harvest() if result["exitCode"] == 0 else ([], 0)
    result["artifacts"] = artifacts
    result["skippedArtifacts"] = skipped
    print(json.dumps(result, ensure_ascii=True, allow_nan=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
