"""Consistent application and sales snapshots, with immutable source/export files."""
from contextlib import closing, contextmanager, ExitStack
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sqlite3
import sys
import tarfile
import tempfile
from datetime import datetime, timezone, timedelta


def load_helper(name):
    spec = importlib.util.spec_from_file_location('backup_' + name, Path(__file__).with_name(name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


storage = load_helper('storage_workdir')


def validation_path(archive):
    return Path(str(archive) + '.validated.json')


def validation_receipt(archive, checksum):
    try:
        path = validation_path(archive)
        if path.is_symlink():
            return None
        receipt = json.loads(path.read_text())
        if (receipt.get('schema') == 1 and receipt.get('archive') == archive.name
                and receipt.get('sha256') == checksum and receipt.get('status') == 'restored_not_started'):
            return receipt
    except (OSError, ValueError):
        pass
    return None


def record_validation(archive, checksum, result):
    if result.get('status') != 'restored_not_started' or digest(archive) != checksum:
        raise RuntimeError('Recovery generation changed or was not restored')
    receipt = {'schema': 1, 'archive': archive.name, 'sha256': checksum,
               'status': result['status'], 'release': result.get('sha'),
               'verified_at': datetime.now(timezone.utc).isoformat()}
    target = validation_path(archive)
    fd, temporary = tempfile.mkstemp(prefix=target.name + '.', suffix='.partial', dir=archive.parent)
    try:
        with os.fdopen(fd, 'w') as output:
            json.dump(receipt, output)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, target)
    finally:
        Path(temporary).unlink(missing_ok=True)
    return receipt


def digest(path: Path) -> str:
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def prune_backups(folder: Path, keep_count: int = 2) -> None:
    """Keep only the newest complete local generations for bounded recovery."""
    if keep_count < 1:
        raise ValueError('Backup retention must keep at least one generation')
    root = folder.resolve()
    complete = []
    invalid = []
    validated = []
    for archive in sorted(folder.glob('mobiup-comenzi-????????T??????Z.tar.gz'), reverse=True):
        if archive.is_symlink() or not archive.resolve().is_relative_to(root):
            continue
        checksum_file = archive.with_suffix(archive.suffix + '.sha256')
        try:
            expected = checksum_file.read_text().split()
        except (OSError, UnicodeError):
            expected = []
        if (len(expected) != 2 or expected[1] != archive.name or len(expected[0]) != 64
                or expected[0] != digest(archive)):
            invalid.append(archive)
            continue
        complete.append(archive)
        if validation_receipt(archive, expected[0]):
            validated.append(archive)
    if not validated:
        # A checksum alone is not authority to remove the last restorable copy.
        return
    keep = set(complete[:keep_count]) | {validated[0]}
    for old in [p for p in complete if p not in keep] + invalid:
        old.unlink()
        old.with_suffix(old.suffix + '.sha256').unlink(missing_ok=True)
        validation_path(old).unlink(missing_ok=True)


def validate_archive(current: Path, validation_root: Path | None = None) -> dict:
    module = load_helper('restore')
    content_bytes, members = module.inspect_archive(current)
    root = (validation_root or current.parent).parent / '.managed-restore-work'
    checksum = digest(current)
    with storage.configured(root, content_bytes, tag='retention-verify',
                            overhead_bytes=64*1024**2 + members*8192) as work:
        result = module.restore(current, work.path / 'restored', scratch=work)
    return record_validation(current, checksum, result)


def prune_nas_latest(folder: Path, current: Path, validation_root: Path | None = None) -> dict:
    """Retain the latest complete verified recovery generation when configured."""
    if current.parent != folder or current.is_symlink():
        raise RuntimeError('Unsafe NAS generation')
    expected = current.with_suffix(current.suffix + '.sha256').read_text().split()
    if expected != [digest(current), current.name]:
        raise RuntimeError('NAS retention checksum mismatch')
    receipt = validate_archive(current, validation_root)
    prune_backups(folder, keep_count=1)
    return receipt


def include_customer_history():
    value = os.environ.get('MOBIUP_BACKUP_CUSTOMER_HISTORY', '1')
    if value not in ('0', '1'):
        raise ValueError('MOBIUP_BACKUP_CUSTOMER_HISTORY must be 0 or 1')
    return value == '1'


@contextmanager
def activation_read_locks(data):
    # Match import/retention locks while pinning and copying immutable generations.
    with ExitStack() as stack:
        for relative in ('activations', 'activations/digi'):
            root = data / relative
            if root.is_dir():
                handle = stack.enter_context((root / '.activation-job.lock').open('a'))
                fcntl.flock(handle, fcntl.LOCK_SH)
        yield


def prune_activation_generations(root):
    """Collect superseded copies only; preserve current, unique imports and readers."""
    if os.geteuid() != 0:
        raise RuntimeError('Activation retention requires root process visibility')
    removed, retained = [], []
    if not root.is_dir() or root.is_symlink():
        return {'removed': removed, 'retained': retained}
    with (root / '.activation-job.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        generations, pointer = root / 'generations', root / 'current'
        if not pointer.is_symlink() or generations.is_symlink():
            return {'removed': removed, 'retained': retained}
        current = pointer.resolve(strict=True)
        if current.parent != generations.resolve() or not current.is_dir():
            raise RuntimeError('Invalid current activation generation')
        def imports(path):
            db = path / 'activations.sqlite'
            if db.is_symlink() or not db.is_file():
                raise ValueError('Invalid generation database')
            with closing(sqlite3.connect(db.as_uri() + '?mode=ro', uri=True)) as c:
                return set(c.execute('SELECT sha256,status FROM activation_imports'))
        current_imports = imports(current)
        for old in sorted(generations.iterdir()):
            if old == current:
                continue
            if old.is_symlink() or not old.is_dir() or storage.active_users(old):
                retained.append(old.name)
                continue
            try:
                old_imports = imports(old)
                if not old_imports or not old_imports.issubset(current_imports):
                    raise ValueError('Unique or unknown imports')
                for original in (old / 'activation-originals').glob('*'):
                    kept = current / 'activation-originals' / original.name
                    if (original.is_symlink() or kept.is_symlink() or not original.is_file()
                            or not kept.is_file() or digest(original) != digest(kept)):
                        raise ValueError('Unique original')
            except (ValueError, OSError, sqlite3.Error):
                retained.append(old.name)
                continue
            if pointer.resolve(strict=True) != current or storage.active_users(old):
                retained.append(old.name)
                continue
            shutil.rmtree(old)
            removed.append(old.name)
    return {'removed': removed, 'retained': retained}


def snapshot_budget(data):
    paths = [data / name for name in ('mobiup.sqlite', 'sales.sqlite', 'usage.sqlite')]
    if include_customer_history():
        paths.append(data / 'client-history/client-sales-history.sqlite')
    for relative in ('activations', 'activations/digi'):
        root = data / relative
        if (root / 'current').is_symlink():
            root = (root / 'current').resolve(strict=True)
        paths.extend(root / name for name in ('activations.sqlite', 'activation-report.sqlite'))
    size = sum(p.stat().st_size + (Path(str(p)+'-wal').stat().st_size if Path(str(p)+'-wal').exists() else 0)
               for p in paths if p.is_file())
    return int(size * 1.1) + 16*1024**2


def sqlite_snapshot(source, copy, work):
    page_size = source.execute('PRAGMA page_size').fetchone()[0]
    accounted = 0
    def progress(status, remaining, total):
        nonlocal accounted
        size = (total - remaining) * page_size
        if size > accounted:
            work.consume(size - accounted)
            accounted = size
    source.backup(copy, pages=256, progress=progress)


class BudgetWriter:
    def __init__(self, stream, work):
        self.stream, self.work = stream, work

    def write(self, value):
        self.work.consume(len(value))
        return self.stream.write(value)

    def __getattr__(self, name):
        return getattr(self.stream, name)


def prune_partials(folder: Path, cutoff: datetime) -> None:
    """Remove only stale interrupted generations owned by this backup job."""
    if not folder.exists():
        return
    root = folder.resolve()
    for partial in folder.glob('mobiup-comenzi-*.tar.gz.partial'):
        if partial.is_symlink() or not partial.resolve().is_relative_to(root):
            continue
        try:
            modified = datetime.fromtimestamp(partial.stat().st_mtime, timezone.utc)
        except FileNotFoundError:
            continue
        if modified < cutoff:
            partial.unlink(missing_ok=True)



def add_recovery_files(output: tarfile.TarFile, recovery: dict[str, Path], release: Path, expected_release: bytes) -> None:
    """Include the exact runnable release and private build inputs, never symlinks."""
    if set(recovery) != {'runtime', 'resources', 'products'}:
        raise RuntimeError('Full recovery requires runtime, resources and products directories')
    roots = {name: path.resolve(strict=True) for name, path in recovery.items()}
    if (roots['runtime'] / 'RELEASE.json').read_bytes() != expected_release:
        raise RuntimeError('Recovery runtime does not match the active release')
    for name, required in [('runtime', 'server.js'), ('resources', 'resource-mode.json')]:
        if not (roots[name] / required).is_file():
            raise RuntimeError(f'Recovery {name} is missing {required}')
    if './bind-ready.mjs' in (roots['runtime'] / 'server.js').read_text() and not (roots['runtime'] / 'bind-ready.mjs').is_file():
        raise RuntimeError('Recovery runtime is missing bind-ready.mjs')
    mode = json.loads((roots['resources'] / 'resource-mode.json').read_text())
    names = ['seed.json', 'initial-users.json', 'accesorii.xlsx', 'standuri.xlsx', 'templates.json', 'template-hashes.json', 'mail-defaults.json']
    if mode.get('mode') != 'private' or mode.get('schema') != 1 or any(name not in mode.get('sha256', {}) for name in names):
        raise RuntimeError('Recovery resources are not complete private production inputs')
    hashes = {}
    for name in names:
        source = (roots['resources'] / name).resolve()
        if not source.is_relative_to(roots['resources']) or digest(source) != mode['sha256'][name]:
            raise RuntimeError('Recovery resource integrity mismatch')
        hashes[name] = mode['sha256'][name]
    resource_digest = hashlib.sha256(json.dumps(hashes, separators=(',', ':')).encode()).hexdigest()
    if json.loads(expected_release).get('resourceDigest') != resource_digest:
        raise RuntimeError('Recovery private inputs do not match the compiled release')
    manifest = {'schema': 1, 'files': {}}
    for name, root in roots.items():
        if not root.is_dir():
            raise RuntimeError(f'Missing recovery directory: {name}')
        files = sorted(root.rglob('*'))
        if not any(path.is_file() for path in files):
            raise RuntimeError(f'Empty recovery directory: {name}')
        for path in files:
            if path.is_symlink() or not path.resolve().is_relative_to(root):
                raise RuntimeError('Recovery tree contains a symlink or escaping path')
            if path.is_dir():
                continue
            if not path.is_file():
                raise RuntimeError('Recovery tree contains a non-regular file')
            key = 'recovery/' + name + '/' + path.relative_to(root).as_posix()
            before = digest(path)
            # Serialize bytes, not inode aliases: hardlinked source files must
            # remain independent regular archive members accepted by restore.
            with path.open('rb') as stream:
                info = output.gettarinfo(fileobj=stream, arcname=key)
                info.type = tarfile.REGTYPE
                info.linkname = ''
                info.size = os.fstat(stream.fileno()).st_size
                output.addfile(info, stream)
            if digest(path) != before:
                raise RuntimeError('Recovery inputs changed during backup; retry the backup')
            manifest['files'][key] = before
    if release.read_bytes() != expected_release:
        raise RuntimeError('Active release changed during backup; retry the backup')
    import io
    payload = json.dumps(manifest, sort_keys=True).encode()
    info = tarfile.TarInfo('recovery/manifest.json')
    info.size = len(payload)
    info.mode = 0o600
    output.addfile(info, io.BytesIO(payload))


def verify_sqlite_snapshot(connection: sqlite3.Connection, label: str) -> None:
    integrity = connection.execute('PRAGMA integrity_check').fetchall()
    if integrity != [('ok',)]:
        raise RuntimeError(f'{label} integrity check failed')
    foreign_keys = connection.execute('PRAGMA foreign_key_check').fetchall()
    if foreign_keys:
        raise RuntimeError(f'{label} foreign key check failed')


def run_backup(
    *,
    data: Path = Path('/storage/comenzi-distributie'),
    local: Path = Path('/storage/backups/comenzi-distributie'),
    nas: Path = Path('/mnt/nas/backups/server-68/comenzi-distributie'),
    nas_mount: Path = Path('/mnt/nas'),
    release: Path = Path('/opt/Mobiup/comenzi-distributie/runtime/current/RELEASE.json'),
    recovery: dict[str, Path] | None = None,
    nas_latest_only: bool = False,
) -> Path:
    """Publish locally first; an offsite failure still exits unsuccessfully.

    Path arguments allow isolated tests without accessing production storage.
    The systemd invocation and default production locations remain unchanged.
    """
    history_enabled = include_customer_history()
    local.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc)
    prune_partials(local, now - timedelta(days=1))
    stamp = now.strftime('%Y%m%dT%H%M%SZ')
    name = f'mobiup-comenzi-{stamp}.tar.gz'
    archive = local / name
    with activation_read_locks(data), storage.configured(local.parent / '.managed-restore-work', snapshot_budget(data), tag='snapshot') as work:
        temporary = work.path
        local_partial = work.path / (name + '.partial')
        snapshot = Path(temporary) / 'mobiup.sqlite'
        with closing(sqlite3.connect(f'file:{data / "mobiup.sqlite"}?mode=ro', uri=True)) as source, closing(sqlite3.connect(snapshot)) as copy:
            sqlite_snapshot(source, copy, work)
            verify_sqlite_snapshot(copy, 'Application snapshot')
            keys = []
            for row in copy.execute("SELECT kind,payload FROM orders WHERE status='finalized'"):
                kind, payload = row
                order = json.loads(payload)
                key = order.get('exportKey')
                # Email-only stand notices intentionally have no Excel attachment.
                # Their complete finalized payload is already in the SQLite snapshot.
                # Relational kind is authoritative, just as in application orderView.
                if kind == 'stand_client' and key is None:
                    continue
                if not isinstance(key, str) or not key:
                    raise RuntimeError('Finalized order is missing its required export key')
                keys.append(key)
        usage_snapshot = Path(temporary) / 'usage.sqlite'
        if (data / 'usage.sqlite').exists():
            if (data / 'usage.sqlite').is_symlink():
                raise RuntimeError('Invalid usage database location')
            with closing(sqlite3.connect(f'file:{data / "usage.sqlite"}?mode=ro', uri=True)) as source, closing(sqlite3.connect(usage_snapshot)) as copy:
                sqlite_snapshot(source, copy, work)
                verify_sqlite_snapshot(copy, 'Usage snapshot')
        sales_snapshot = Path(temporary) / 'sales.sqlite'
        if (data / 'sales.sqlite').exists():
            with closing(sqlite3.connect(f'file:{data / "sales.sqlite"}?mode=ro', uri=True)) as source, closing(sqlite3.connect(sales_snapshot)) as copy:
                sqlite_snapshot(source, copy, work)
                verify_sqlite_snapshot(copy, 'Sales snapshot')
        # Sources are immutable and published before their database transaction.
        # Enumerating after the snapshot includes all its sources; extra newer files
        # are harmless and do not change the generation recorded in the snapshot.
        sales_sources = sorted(path for path in (data / 'sales-imports').glob('*') if path.suffix in ('.xlsx', '.xls')) if sales_snapshot.exists() else []
        history_snapshot = Path(temporary) / 'client-sales-history.sqlite'
        history_root = data / 'client-history'
        history_db = history_root / 'client-sales-history.sqlite'
        history_sources = []
        if history_enabled and history_db.exists():
            if history_root.is_symlink() or history_db.is_symlink():
                raise RuntimeError('Invalid customer history location')
            with closing(sqlite3.connect(f'file:{history_db}?mode=ro', uri=True)) as source, closing(sqlite3.connect(history_snapshot)) as copy:
                sqlite_snapshot(source, copy, work)
                verify_sqlite_snapshot(copy, 'Customer history snapshot')
                for expected, relative in copy.execute('SELECT sha256,original_path FROM history_imports'):
                    path = history_root / relative
                    if path.is_symlink() or not path.resolve().is_relative_to(history_root.resolve()) or not path.is_file() or digest(path) != expected:
                        raise RuntimeError('Customer history original missing or checksum mismatch')
                    history_sources.append((path, relative, expected))
        activation_snapshots = []
        activation_sources = []
        for activation_relative in ('activations', 'activations/digi'):
            activation_root = data / activation_relative
            # Pin the supported immutable generation once; flatten it in recovery archives.
            pointer = activation_root / 'current'
            if pointer.exists() or pointer.is_symlink():
                generations = activation_root / 'generations'
                if not pointer.is_symlink() or generations.is_symlink() or not generations.is_dir():
                    raise RuntimeError('Invalid activation generation location')
                pinned = pointer.resolve(strict=True)
                if pinned.parent != generations.resolve() or not pinned.is_dir() or pinned.is_symlink():
                    raise RuntimeError('Invalid activation generation location')
                activation_root = pinned
            activation_db = activation_root / 'activations.sqlite'
            if not activation_db.exists():
                continue
            if any(parent.is_symlink() for parent in (data / 'activations', activation_root, activation_db)):
                raise RuntimeError('Invalid activation database location')
            for activation_name in ('activations.sqlite', 'activation-report.sqlite'):
                original = activation_root / activation_name
                if original.is_symlink() or not original.is_file():
                    raise RuntimeError('Missing or invalid activation database')
                snapshot_path = Path(temporary) / (activation_relative.replace('/', '-') + '-' + activation_name)
                with closing(sqlite3.connect(original.as_uri() + '?mode=ro', uri=True)) as source, closing(sqlite3.connect(snapshot_path)) as copy:
                    sqlite_snapshot(source, copy, work)
                    verify_sqlite_snapshot(copy, 'Activation snapshot')
                    if activation_name == 'activations.sqlite':
                        for (expected,) in copy.execute("SELECT sha256 FROM activation_imports WHERE status='complete'"):
                            if len(expected) != 64 or any(c not in '0123456789abcdef' for c in expected):
                                raise RuntimeError('Invalid activation source checksum')
                            path = activation_root / 'activation-originals' / (expected + '.xlsx')
                            if path.is_symlink() or not path.resolve().is_relative_to(activation_root.resolve()) or not path.is_file() or digest(path) != expected:
                                raise RuntimeError('Activation original missing or checksum mismatch')
                            activation_sources.append((path, expected, activation_relative))
                activation_snapshots.append((snapshot_path, activation_relative + '/' + activation_name))
            pinned_snapshots = {name.rsplit('/',1)[-1]:path for path,name in activation_snapshots if name.rsplit('/',1)[0]==activation_relative}
            if len(pinned_snapshots)==2:
                with closing(sqlite3.connect(pinned_snapshots['activations.sqlite'])) as ledger, closing(sqlite3.connect(pinned_snapshots['activation-report.sqlite'])) as report:
                    has_meta = ledger.execute("SELECT 1 FROM sqlite_master WHERE name='activation_meta'").fetchone()
                    if has_meta and dict(ledger.execute('SELECT key,value FROM activation_meta')).get('schema_version')=='3':
                        source_meta = dict(ledger.execute('SELECT key,value FROM activation_meta'))
                        report_meta = dict(report.execute('SELECT key,value FROM report_meta'))
                        if source_meta.get('generation','')!=report_meta.get('sourceGeneration'):
                            raise RuntimeError('Incoherent activation generation')
                        imports = ledger.execute("SELECT sha256,operator,row_count,parser_version FROM activation_imports WHERE status='complete' ORDER BY sha256").fetchall()
                        if json.dumps(imports,separators=(',',':'))!=report_meta.get('sourceImports'):
                            raise RuntimeError('Stale activation projection in backup')
        policy = work.path / 'BACKUP-POLICY.json'
        policy.write_text(json.dumps({'schema': 1, 'customerHistory': 'included' if history_enabled else 'reimport_required'}))
        captured_release = release.read_bytes()
        archive_inputs = [p for p in work.path.iterdir() if p.is_file() and p.suffix == '.sqlite']
        archive_inputs += [p for p, _, _ in activation_sources] + [p for p, _, _ in history_sources] + sales_sources
        archive_inputs += [data / 'files' / key for key in keys] + [release]
        if recovery:
            archive_inputs += [p for root in recovery.values() for p in root.rglob('*') if p.is_file()]
        archive_bytes = sum(p.stat().st_size for p in archive_inputs)
        # Tar headers/padding and worst-case gzip growth, not its compressed size.
        work.extend(int(archive_bytes * 1.01) + len(archive_inputs)*2048 + 64*1024**2)
        try:
            with local_partial.open('xb') as raw, tarfile.open(fileobj=BudgetWriter(raw, work), mode='w:gz', compresslevel=2) as output:
                if not history_enabled:
                    output.add(policy, arcname='BACKUP-POLICY.json')
                output.add(snapshot, arcname='mobiup.sqlite')
                if usage_snapshot.exists():
                    output.add(usage_snapshot, arcname='usage.sqlite')
                if sales_snapshot.exists():
                    output.add(sales_snapshot, arcname='sales.sqlite')
                if history_snapshot.exists():
                    output.add(history_snapshot, arcname='client-history/client-sales-history.sqlite')
                for path, activation_name in activation_snapshots:
                    output.add(path, arcname=activation_name)
                for path, expected, activation_relative in activation_sources:
                    output.add(path, arcname=activation_relative + '/activation-originals/' + path.name)
                    if digest(path) != expected:
                        raise RuntimeError('Activation source changed during backup')
                for path, relative, expected in history_sources:
                    output.add(path, arcname='client-history/' + relative)
                    if digest(path) != expected:
                        raise RuntimeError('Customer history source changed during backup')
                for path in sales_sources:
                    if path.is_symlink() or not path.is_file() or not path.resolve().is_relative_to((data / 'sales-imports').resolve()):
                        raise RuntimeError('Invalid sales source location')
                    output.add(path, arcname='sales-imports/' + path.name)
                for key in keys:
                    path = (data / 'files' / key).resolve()
                    if not path.is_relative_to((data / 'files').resolve()):
                        raise RuntimeError('Invalid export location')
                    output.add(path, arcname='files/' + key)
                output.add(release, arcname='RELEASE.json')
                if recovery is not None:
                    add_recovery_files(output, recovery, release, captured_release)
                if release.read_bytes() != captured_release:
                    raise RuntimeError('Release changed during archive creation')
            local_partial.replace(archive)
        except Exception:
            local_partial.unlink(missing_ok=True)
            raise
    checksum = digest(archive)
    checksum_file = archive.with_suffix(archive.suffix + '.sha256')
    checksum_file.write_text(f'{checksum}  {name}\n')
    print(f'Verified local backup: {name}; exports={len(keys)}; sales_sources={len(sales_sources)}; sha256={checksum}', flush=True)
    # Local retention must not depend on NAS availability or write permissions.
    prune_backups(local)

    temporary_copy = nas / (name + '.partial')
    try:
        # Check before mkdir/copy: do not write a fake NAS backup to local disk.
        if not os.path.ismount(nas_mount):
            raise RuntimeError('NAS is not mounted')
        nas.mkdir(parents=True, exist_ok=True)
        prune_partials(nas, now - timedelta(days=1))
        shutil.copyfile(archive, temporary_copy)
        if digest(temporary_copy) != checksum:
            raise RuntimeError('NAS backup checksum mismatch')
        temporary_copy.replace(nas / name)
        shutil.copyfile(checksum_file, nas / checksum_file.name)
        if nas_latest_only:
            receipt = prune_nas_latest(nas, nas / name, local)
            record_validation(archive, checksum, {'status': receipt['status'], 'sha': receipt['release']})
            prune_backups(local)
        else:
            prune_backups(nas)
    except (OSError, RuntimeError) as error:
        temporary_copy.unlink(missing_ok=True)
        # Preserve the verified local generation, but let systemd report failure.
        raise RuntimeError(f'Local backup verified: {name}; NAS backup failed: {error}') from error

    print(f'Verified local and NAS backup: {name}; exports={len(keys)}; sales_sources={len(sales_sources)}; sha256={checksum}')
    return archive


if __name__ == '__main__':
    if sys.argv[1:] == ['--prune-activation-generations']:
        for relative in ('activations', 'activations/digi'):
            print(json.dumps(prune_activation_generations(Path('/storage/comenzi-distributie') / relative)), flush=True)
        raise SystemExit(0)
    if not os.environ.get('MOBIUP_SCRATCH_ROOT'):
        raise RuntimeError('MOBIUP_SCRATCH_ROOT must be configured outside permanent backup directories')
    configured = {name: os.environ.get('MOBIUP_RECOVERY_' + name.upper(), '') for name in ('runtime', 'resources', 'products')}
    if any(configured.values()) and not all(configured.values()):
        raise RuntimeError('Incomplete recovery configuration')
    run_backup(recovery={name: Path(value) for name, value in configured.items()} if all(configured.values()) else None,
               nas_latest_only=os.environ.get('MOBIUP_NAS_LATEST_ONLY') == '1')
