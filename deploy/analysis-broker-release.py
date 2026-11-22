#!/usr/bin/python3 -I
"""Prepare and select immutable analysis launchers using the application's release manifest."""

import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile


ROOT = Path("/opt/mobiup-analysis-runtime")
STORE = ROOT / "broker-artifacts"
FILENAME = "comenzi-analysis-broker.mjs"
RELEASES = Path("/opt/Mobiup/comenzi-distributie/runtime/releases")


def artifact_digest(manifest):
    if manifest.get("resourceMode") != "private" or not re.fullmatch(r"[a-f0-9]{40}", manifest.get("sha", "")):
        raise ValueError("Invalid private release identity")
    if "analysisBroker" not in manifest:
        return None
    metadata = manifest["analysisBroker"]
    if not isinstance(metadata, dict) or type(metadata.get("schema")) is not int or metadata["schema"] != 1:
        raise ValueError("Unsupported analysis broker metadata")
    digest = metadata.get("sha256")
    if not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest):
        raise ValueError("Invalid analysis broker digest")
    return digest


def managed(path, uid, directory=False):
    info = path.lstat()
    correct_type = stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)
    if not correct_type or info.st_uid != uid or info.st_mode & 0o022:
        raise ValueError("Unsafe ownership, type or permissions on the analysis broker")


def selected(manifest, store, uid):
    digest = artifact_digest(manifest)
    if digest is None:
        return None
    managed(store, uid, directory=True)
    if not store.stat().st_mode & stat.S_IXOTH:
        raise ValueError("Broker store must be traversable by the service identity")
    path = store / (digest + ".mjs")
    managed(path, uid)
    with path.open("rb") as data:
        if hashlib.file_digest(data, "sha256").hexdigest() != digest:
            raise ValueError("Installed analysis broker does not match the active release")
    return path


def prepare(release, store, uid):
    manifest = json.loads((release / "RELEASE.json").read_text())
    if release.name != manifest.get("sha"):
        raise ValueError("Analysis broker release path does not match its identity")
    digest = artifact_digest(manifest)
    source = release / FILENAME
    if digest is None:
        if os.path.lexists(source):
            raise ValueError("Broker payload lacks release metadata")
        return
    managed(store.parent, uid, directory=True)
    try:
        store.mkdir(mode=0o755)
    except FileExistsError:
        pass
    else:
        store.chmod(0o755)
    managed(store, uid, directory=True)
    destination = store / (digest + ".mjs")
    # A regular file descriptor and a digest check also cover a concurrent source replacement.
    with os.fdopen(os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), "rb") as data:
        if not stat.S_ISREG(os.fstat(data.fileno()).st_mode):
            raise ValueError("Invalid analysis broker payload")
        with tempfile.NamedTemporaryFile(dir=store, delete=False) as tmp:
            pending = Path(tmp.name)
            try:
                observed = hashlib.sha256()
                for chunk in iter(lambda: data.read(65536), b""):
                    observed.update(chunk)
                    tmp.write(chunk)
                if observed.hexdigest() != digest:
                    raise ValueError("Analysis broker payload does not match the release")
                tmp.flush()
                os.fchmod(tmp.fileno(), 0o444)
                os.fsync(tmp.fileno())
                try:
                    os.link(pending, destination)
                except FileExistsError:
                    pass
            finally:
                pending.unlink(missing_ok=True)
    selected(manifest, store, uid)
    fd = os.open(store, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def main():
    if len(sys.argv) == 3 and sys.argv[1] == "prepare":
        if os.geteuid() != 0:
            raise PermissionError("Analysis broker installation requires the release administrator")
        release = Path(sys.argv[2]).resolve(strict=True)
        if release.parent != RELEASES.resolve(strict=True):
            raise ValueError("Unexpected private release directory")
        prepare(release, STORE, 0)
    elif len(sys.argv) == 4 and sys.argv[1] == "launch":
        if os.geteuid() == 0:
            raise PermissionError("Analysis broker execution requires an unprivileged service identity")
        manifest = json.loads(Path(sys.argv[2]).read_text())
        artifact = selected(manifest, STORE, 0)
        if artifact is None:
            raise ValueError("The active release predates the analysis broker")
        os.execv(sys.argv[3], [sys.argv[3], str(artifact)])
    else:
        raise ValueError("Expected prepare RELEASE or launch CREDENTIAL NODE")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, TypeError) as error:
        sys.exit(f"analysis-broker-release: {error}")
