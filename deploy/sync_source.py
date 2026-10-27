"""Safely fast-forward the canonical checkout selected by an application registry.

Runtime releases and persistent data are never moved. Dirty or divergent trees
are preserved. Compatibility mirrors are secondary and cannot redefine authority.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import re
import subprocess


def git(path, *args, check=True):
    return subprocess.run(['git', '-C', str(path), *args], check=check, capture_output=True,
                          text=True, timeout=60)


def synchronize(path, sha, branch):
    path = Path(path)
    if not re.fullmatch('[0-9a-f]{40}', sha) or not re.fullmatch('[A-Za-z0-9._/-]+', branch) or branch.startswith('-'):
        raise ValueError('Invalid source identity')
    if git(path, 'status', '--porcelain').stdout.strip():
        raise RuntimeError('Dirty source checkout; preserve concurrent work')
    head = git(path, 'rev-parse', 'HEAD').stdout.strip()
    git(path, 'fetch', '--no-tags', 'origin', branch)
    if git(path, 'merge-base', '--is-ancestor', sha, 'FETCH_HEAD', check=False).returncode:
        raise RuntimeError('Release is not in the authorized remote branch')
    if head == sha:
        return {'path': str(path), 'status': 'aligned', 'sha': head}
    if not git(path, 'merge-base', '--is-ancestor', head, sha, check=False).returncode:
        git(path, 'merge', '--ff-only', sha)
        if git(path, 'rev-parse', 'HEAD').stdout.strip() != sha:
            raise RuntimeError('Source changed concurrently; inspect before activation')
        return {'path': str(path), 'status': 'fast-forwarded', 'sha': sha}
    if not git(path, 'merge-base', '--is-ancestor', sha, head, check=False).returncode:
        if git(path, 'merge-base', '--is-ancestor', head, 'FETCH_HEAD', check=False).returncode:
            raise RuntimeError('Source contains unpublished work; refusing reconciliation')
        # An attended rollback may intentionally select an earlier runtime.
        # Do not reset source history to manufacture an alignment claim.
        return {'path': str(path), 'status': 'source-ahead', 'sha': head, 'runtime_sha': sha}
    raise RuntimeError('Divergent source checkout; refusing history rewrite')


def reconcile(registry, app_id, host, sha):
    spec = importlib.util.spec_from_file_location('source_registry', registry)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    rows = [row for row in module.APPLICATION_REGISTRY if row['id'] == app_id]
    if len(rows) != 1:
        raise RuntimeError('Application registry identity is missing or ambiguous')
    config = rows[0]['project_ops']
    path = config['dell_source_path' if host == 'dell' else 'source_path']
    result = {'canonical': synchronize(path, sha, config['default_branch']), 'mirrors': []}
    for mirror in config.get('source_mirrors', {}).get(host, []):
        if Path(mirror).resolve() == Path(path).resolve():
            continue
        try:
            result['mirrors'].append(synchronize(mirror, sha, config['default_branch']))
        except (RuntimeError, OSError, subprocess.SubprocessError) as error:
            result['mirrors'].append({'path': mirror, 'status': 'preserved-needs-attention', 'reason': str(error)})
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--registry', type=Path, required=True)
    parser.add_argument('--app-id', required=True)
    parser.add_argument('--host', choices=['server', 'dell'], required=True)
    parser.add_argument('--sha', required=True)
    args = parser.parse_args()
    print(json.dumps(reconcile(args.registry, args.app_id, args.host, args.sha)))
