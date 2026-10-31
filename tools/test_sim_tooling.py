"""Synthetic selection checks; never import or access private automation."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import types
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('sim_tooling', ROOT / 'deploy/sim_tooling.py')
tooling = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tooling)


class ToolingTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        self.runtime = self.base / 'runtime'; self.runtime.mkdir()
        (self.runtime / 'RELEASE.json').write_text(json.dumps({'sha': 'a' * 40}))
        self.tools = self.base / 'tooling/reviewed'; self.tools.mkdir(parents=True)
        (self.tools / 'activations.py').write_text("CHRONOLOGY_POLICY_VERSION = 'positive-documents-nonblocking-v1'\n")
        (self.tools / 'activation_versions.py').write_text("FACTS_VERSION = '2'\n")
        selected = {'path': 'tooling/reviewed', 'compatibleRuntime': 'a' * 40,
                    'files': {name: tooling.digest(self.tools / name) for name in tooling.REQUIRED_FILES}}
        self.config = {'schema': 1, 'contract': tooling.CONTRACT, 'vodafone': selected, 'digi': dict(selected)}
        self.save()

    def save(self):
        (self.base / 'provider-tooling.json').write_text(json.dumps(self.config))

    def select(self, provider='digi'):
        return tooling.provider_tooling(self.base, provider, self.runtime)

    def test_selects_both_reviewed_providers(self):
        for provider in ('vodafone', 'digi'):
            self.assertEqual(Path(self.select(provider)['path']), self.tools)

    def test_missing_configuration_never_uses_legacy_configuration(self):
        (self.base / 'digi-tooling.json').write_text(json.dumps(self.config['digi']))
        (self.base / 'provider-tooling.json').unlink()
        with self.assertRaises(FileNotFoundError): self.select()

    def test_missing_empty_provider_and_old_contract_fail_closed(self):
        for config in ({}, {'digi': {}}, {**self.config, 'digi': None},
                       {k: v for k, v in self.config.items() if k != 'digi'},
                       {**self.config, 'contract': 'old-policy'}, {**self.config, 'schema': 2}):
            with self.subTest(config=config):
                self.config = config; self.save()
                with self.assertRaises(ValueError): self.select()

    def test_missing_empty_or_partial_hash_map_fails_closed(self):
        for files in (None, {}, {'activations.py': 'a' * 64}):
            with self.subTest(files=files):
                self.config['digi']['files'] = files; self.save()
                with self.assertRaisesRegex(ValueError, 'file set'): self.select()

    def test_missing_file_and_hash_mismatch_fail_closed(self):
        selected = self.tools / 'activations.py'
        original = selected.read_bytes()
        selected.unlink()
        with self.assertRaises(FileNotFoundError): self.select()
        selected.write_bytes(original + b'# changed\n')
        with self.assertRaisesRegex(ValueError, 'checksum'): self.select()

    def test_compatible_runtime_is_exact_release_identity(self):
        (self.runtime / 'RELEASE.json').write_text(json.dumps({'sha': 'b' * 40}))
        with self.assertRaisesRegex(ValueError, 'compatibility'): self.select()

    def test_absolute_traversing_and_symlink_tooling_paths_fail_closed(self):
        for path in (str(self.tools), 'tooling/../tooling/reviewed', 'tooling//reviewed'):
            with self.subTest(path=path):
                self.config['digi']['path'] = path; self.save()
                with self.assertRaises(ValueError): self.select()
        (self.base / 'tooling/alias').symlink_to(self.tools, target_is_directory=True)
        self.config['digi']['path'] = 'tooling/alias'; self.save()
        with self.assertRaisesRegex(ValueError, 'symlink'): self.select()

    def test_old_chronology_rejected_even_with_reviewed_hash(self):
        path = self.tools / 'activations.py'; path.write_text("CHRONOLOGY_POLICY_VERSION = 'old'\n")
        self.config['digi']['files']['activations.py'] = tooling.digest(path); self.save()
        with self.assertRaisesRegex(ValueError, 'chronology'): self.select()

    def test_import_cache_cannot_select_older_runtime_module(self):
        selected = self.select()
        older = types.SimpleNamespace(__file__=str(self.runtime / 'activations.py'))
        versions = types.SimpleNamespace(__file__=str(self.tools / 'activation_versions.py'))
        with self.assertRaisesRegex(ValueError, 'Loaded importer'): tooling.validate_loaded(selected, older, versions)


if __name__ == '__main__':
    unittest.main()
