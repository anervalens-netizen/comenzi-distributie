"""Build the distribution browser test's Digi ledger using the Excel import executor."""
import shutil
import sqlite3
import sys
import uuid
from pathlib import Path
from test_import_engine_sim import SimExecutorTests
from import_engine_sim import run


def execute(job, action):
    return run({'job': job, 'mode': 'execute', 'action': action, 'action_id': str(uuid.uuid4())})


def publish(job, already_imported):
    job['preview'] = execute(job, 'preview')['preview']
    assert job['preview']['alreadyImported'] == already_imported
    assert execute(job, 'commit')['state'] == 'completed'


def main(root):
    case = SimExecutorTests()
    case.setUp()
    try:
        with sqlite3.connect(case.settings) as settings:
            settings.execute("UPDATE settings SET value=? WHERE key='distribution-rules-v1'",
                             ((root / 'rules.json').read_text(),))
        for start, end, day, serial in [('01', '15', '05', 11), ('16', '31', '24', 12)]:
            job = case.source('sim_activations_digi', activation_day='2026-10-' + day,
                              iccid=str(serial).zfill(19))
            job['source'].update(date_start='2026-10-' + start, date_end='2026-10-' + end,
                                 source_at='2026-11-01')
            publish(job, False)
        job['payload']['company'] = 'exampleco'
        publish(job, True)
        active = (case.digi / 'current').resolve()
        with sqlite3.connect(active / 'activations.sqlite') as db:
            assert db.execute("SELECT count(*) FROM activation_imports WHERE source_kind='operator'").fetchone() == (2,)
        shutil.copytree(active, root / 'digi')
    finally:
        case.tearDown()


if __name__ == '__main__':
    main(Path(sys.argv[1]))
