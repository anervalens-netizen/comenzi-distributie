#!/usr/bin/env python3
"""Run the geocoder with a private provider key, never logged or passed in argv."""
import os
import shutil
from pathlib import Path

repo = Path(__file__).resolve().parents[1]
key_file = os.environ.get('GEOAPIFY_KEY_FILE')
if not os.environ.get('GEOAPIFY_API_KEY'):
    if not key_file:
        raise SystemExit('Configure GEOAPIFY_API_KEY or GEOAPIFY_KEY_FILE privately.')
    os.environ['GEOAPIFY_API_KEY'] = Path(key_file).read_text().strip()
node = os.environ.get('NODE_BINARY') or shutil.which('node')
if not node:
    raise SystemExit('Node.js is required.')
os.execv(node, [node, str(repo / 'tools/partner-geocode-worker.mjs')])
