"""Fail-closed selection of explicitly reviewed recurring-import tooling.

Configuration uses paths relative to its private automation directory so the
same reviewed bytes can be validated after an isolated recovery.
"""
import ast
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re

CONTRACT = 'sim-chronology-v1'
CHRONOLOGY_POLICY = 'positive-documents-nonblocking-v1'
REQUIRED_FILES = frozenset(('activations.py', 'activation_versions.py'))


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def relative_file(base, name):
    if not isinstance(name, str):
        raise ValueError('Tooling path must be relative')
    relative = PurePosixPath(name)
    if relative.is_absolute() or not relative.parts or '..' in relative.parts or str(relative) != name:
        raise ValueError('Tooling path must be canonical and relative')
    target = base / name
    if any(p.is_symlink() for p in [target, *target.parents] if p != base.parent and p.is_relative_to(base)):
        raise ValueError('Tooling paths must not contain symlinks')
    if not target.resolve(strict=True).is_relative_to(base.resolve(strict=True)) or not target.is_file():
        raise ValueError('Required tooling file missing or outside configured root')
    return target


def constant(path, name):
    tree = ast.parse(path.read_text())
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == name for target in node.targets):
            return ast.literal_eval(node.value)
    return None


def provider_tooling(base, provider, runtime):
    """No default importer or legacy configuration is an acceptable fallback."""
    base, runtime = Path(base).absolute(), Path(runtime).resolve(strict=True)
    if provider not in ('vodafone', 'digi'):
        raise ValueError('Invalid tooling provider')
    config = json.loads(relative_file(base, 'provider-tooling.json').read_text())
    if not isinstance(config, dict) or config.get('schema') != 1 or config.get('contract') != CONTRACT:
        raise ValueError('Required importer tooling contract is missing or unsupported')
    tooling = config.get(provider)
    if not isinstance(tooling, dict) or not tooling:
        raise ValueError('Required provider tooling configuration is missing')
    files = tooling.get('files')
    if not isinstance(files, dict) or set(files) != REQUIRED_FILES:
        raise ValueError('Required provider tooling file set is incomplete')
    compatible = tooling.get('compatibleRuntime')
    if not isinstance(compatible, str) or not re.fullmatch(r'[a-f0-9]{40}', compatible):
        raise ValueError('Importer tooling runtime compatibility requires review')
    release = json.loads((runtime / 'RELEASE.json').read_text())
    if release.get('sha') != compatible:
        raise ValueError('Importer tooling runtime compatibility requires review')
    relative = tooling.get('path')
    if not isinstance(relative, str) or not relative.startswith('tooling/'):
        raise ValueError('Importer tooling must use a relative tooling directory')
    selected = {}
    for name, checksum in files.items():
        if not isinstance(checksum, str) or not re.fullmatch(r'[a-f0-9]{64}', checksum):
            raise ValueError('Invalid importer tooling checksum')
        path = relative_file(base, relative + '/' + name)
        if digest(path) != checksum:
            raise ValueError('Importer tooling checksum mismatch')
        selected[name] = path
    if constant(selected['activations.py'], 'CHRONOLOGY_POLICY_VERSION') != CHRONOLOGY_POLICY:
        raise ValueError('Importer tooling chronology policy is unsupported')
    if constant(selected['activation_versions.py'], 'FACTS_VERSION') != '2':
        raise ValueError('Importer tooling facts version is unsupported')
    return {**tooling, 'path': str(selected['activations.py'].parent), 'contract': CONTRACT}


def validate_loaded(tooling, activations, versions):
    """Ensure import caching or path precedence did not select older modules."""
    for name, module in [('activations.py', activations), ('activation_versions.py', versions)]:
        expected = Path(tooling['path']) / name
        if Path(module.__file__).resolve() != expected.resolve() or digest(expected) != tooling['files'][name]:
            raise ValueError('Loaded importer does not match required tooling')
    if activations.CHRONOLOGY_POLICY_VERSION != CHRONOLOGY_POLICY or versions.FACTS_VERSION != '2':
        raise ValueError('Loaded importer does not support required tooling contract')


def recovery_files(base, runtime):
    """Validate a small explicit automation allowlist; never recurse into inputs."""
    base = Path(base).absolute()
    descriptor = relative_file(base, 'recovery-files.json')
    policy = json.loads(descriptor.read_text())
    names = policy.get('files') if isinstance(policy, dict) else None
    if not isinstance(policy, dict) or policy.get('schema') != 1 or policy.get('contract') != CONTRACT or not isinstance(names, list):
        raise ValueError('Invalid automation recovery policy')
    if len(names) != len(set(names)) or len(names) > 1000:
        raise ValueError('Invalid automation recovery file list')
    directories = policy.get('optionalDirectories', [])
    if not isinstance(directories, list) or len(directories) != len(set(directories)) or len(directories) > 1000:
        raise ValueError('Invalid automation recovery directories')
    visited, selected_bytes, explicit_count = len(directories), 0, len(names)
    for name in directories:
        relative = PurePosixPath(name)
        if relative.is_absolute() or '..' in relative.parts or str(relative) != name or not relative.parts:
            raise ValueError('Automation recovery directory must be relative')
        directory = base / name
        if directory.is_symlink():
            raise ValueError('Automation recovery directory must not be a symlink')
        if not directory.exists():
            continue
        if not directory.is_dir():
            raise ValueError('Automation recovery directory is not a directory')
        pending = [directory]
        while pending:
            with os.scandir(pending.pop()) as entries:
                for entry in entries:
                    visited += 1
                    if visited + explicit_count > 1000:
                        raise ValueError('Automation recovery exceeds 1000 entries')
                    if entry.is_symlink():
                        raise ValueError('Automation recovery directory contains a symlink')
                    if entry.is_dir(follow_symlinks=False):
                        pending.append(Path(entry.path))
                    elif entry.is_file(follow_symlinks=False):
                        selected_bytes += entry.stat(follow_symlinks=False).st_size
                        if selected_bytes > 16 * 1024**2:
                            raise ValueError('Automation recovery payload exceeds 16 MiB')
                        names.append(Path(entry.path).relative_to(base).as_posix())
                    else:
                        raise ValueError('Automation recovery contains a non-regular file')
    if len(names) != len(set(names)) or len(names) > 1000:
        raise ValueError('Invalid automation recovery file list')
    required = {'run_import.py', 'provider-tooling.json'}
    files = {name: relative_file(base, name) for name in names}
    if not required.issubset(files):
        raise ValueError('Required automation recovery files are missing')
    runner_hash = policy.get('runnerSha256')
    if (not isinstance(runner_hash, str) or not re.fullmatch(r'[a-f0-9]{64}', runner_hash)
            or digest(files['run_import.py']) != runner_hash
            or constant(files['run_import.py'], 'TOOLING_CONTRACT') != CONTRACT):
        raise ValueError('Automation recovery runner contract or checksum mismatch')
    selections = {}
    for provider in ('vodafone', 'digi'):
        tooling = provider_tooling(base, provider, runtime)
        relative = Path(tooling['path']).relative_to(base).as_posix()
        if not {relative + '/' + name for name in REQUIRED_FILES}.issubset(files):
            raise ValueError('Required automation recovery tooling is not selected')
        selections[provider] = {'path': relative, 'contract': tooling['contract'],
                                'compatibleRuntime': tooling['compatibleRuntime'], 'files': tooling['files']}
    files['recovery-files.json'] = descriptor
    if sum(path.stat().st_size for path in files.values()) > 16 * 1024**2:
        raise ValueError('Automation recovery payload exceeds 16 MiB')
    return files, selections
