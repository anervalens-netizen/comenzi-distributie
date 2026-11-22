"""Verify content-addressed broker selection and the ordinary release rollback."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest


root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("broker_release", root / "deploy/analysis-broker-release.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class BrokerReleaseTest(unittest.TestCase):
    def test_active_manifest_selects_exact_immutable_payload(self):
        uid = os.geteuid()
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            store = folder / "broker-artifacts"
            current = folder / "current"

            def release(number, payload=None):
                sha = f"{number:040x}"
                target = folder / sha
                target.mkdir()
                manifest = {"sha": sha, "resourceMode": "private"}
                if payload is not None:
                    (target / module.FILENAME).write_bytes(payload)
                    digest = hashlib.sha256(payload).hexdigest()
                    manifest["analysisBroker"] = {"schema": 1, "sha256": digest}
                (target / "RELEASE.json").write_text(json.dumps(manifest))
                return target

            def active(target):
                switch = folder / ".next"
                switch.symlink_to(target)
                os.replace(switch, current)
                return module.selected(json.loads((current / "RELEASE.json").read_text()), store, uid)

            legacy = release(1)
            first = release(2, b"first")
            same = release(3, b"first")
            second = release(4, b"second")
            for target in (legacy, first, same, second):
                module.prepare(target, store, uid)
            self.assertEqual(len(list(store.iterdir())), 2)
            self.assertEqual(active(first).read_bytes(), b"first")
            self.assertEqual(active(second).read_bytes(), b"second")
            self.assertEqual(active(first).read_bytes(), b"first")
            self.assertIsNone(active(legacy))
            (second / module.FILENAME).write_bytes(b"unexpected")
            with self.assertRaises(ValueError):
                module.prepare(second, store, uid)
            (legacy / module.FILENAME).write_bytes(b"untracked")
            with self.assertRaises(ValueError):
                module.prepare(legacy, store, uid)
            (first / module.FILENAME).unlink()
            (first / module.FILENAME).symlink_to(second / module.FILENAME)
            with self.assertRaises(OSError):
                module.prepare(first, store, uid)


if __name__ == "__main__":
    unittest.main()
