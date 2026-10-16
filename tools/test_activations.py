"""Wholly synthetic activation import and reconciliation acceptance tests."""
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
import zipfile
from xml.sax.saxutils import escape
import activations as a


def row(**changes):
    r = dict.fromkeys(a.HEADERS, '')
    r.update(Firma='ExampleCo', Furnizor='ExampleProvider', DataVDF='20240101', TR='TR Example',
             SiteCode='SITE-A', ItemCode='SIM-EXAMPLE', ItemName='Example SIM', ItemType='SIM',
             IMEI='0000000000000000010', Activat='000000000000000001', DataActivare='20260315',
             Qtty='1', Cantitate='500', CIF='EXAMPLE', CodPunctDeLucru='POINT-A',
             DocumentDetailId='DETAIL-1', DocumentId='DOC-1')
    r.update(changes)
    return r


def fixture(path, rows, headers=None, numeric=None, shared_empty=False):
    headers = headers or a.HEADERS
    def col(i):
        return (chr(64 + i // 26) if i >= 26 else '') + chr(65 + i % 26)
    lines = []
    for rn, r in [(5, headers)] + [(i + 6, [v[h] for h in headers]) for i, v in enumerate(rows)]:
        cells = []
        for i, value in enumerate(r):
            ref = col(i) + str(rn)
            if rn > 5 and headers[i] == numeric:
                cells.append(f'<c r="{ref}"><v>{escape(value)}</v></c>')
            elif rn > 5 and headers[i] == 'Activat' and shared_empty:
                cells.append(f'<c r="{ref}" t="s"><v>0</v></c>')
            else:
                cells.append(f'<c r="{ref}" t="inlineStr"><is><t>{escape(value)}</t></is></c>')
        lines.append(f'<row r="{rn}">{"".join(cells)}</row>')
    ns = a.NS['s']
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('xl/workbook.xml', f'<workbook xmlns="{ns}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="SIM" r:id="r1"/></sheets></workbook>')
        z.writestr('xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>')
        z.writestr('xl/worksheets/sheet1.xml', f'<worksheet xmlns="{ns}"><sheetData>{"".join(lines)}</sheetData></worksheet>')
        if shared_empty:
            z.writestr('xl/sharedStrings.xml', f'<sst xmlns="{ns}"><si><t></t></si></sst>')
    return path


class ActivationsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.c = a.connect(self.root / 'data')
        self.n = 0

    def tearDown(self):
        self.c.close()
        self.tmp.cleanup()

    def load(self, rows, **kwargs):
        self.n += 1
        path = fixture(self.root / f'input-{self.n}.xlsx', rows, **kwargs)
        return a.import_files(self.c, self.root / 'data', [path]), path

    def fact(self):
        return dict(self.c.execute('SELECT * FROM activation_facts').fetchone())

    def test_old_sale_current_activation_and_exact_serial(self):
        result, _ = self.load([row()])
        self.assertEqual(result['facts'], 1)
        f = self.fact()
        self.assertEqual(f['month'], '2026-03')
        self.assertEqual(f['serial'], '000000000000000001')
        self.assertEqual(f['net_quantity'], 1)  # never Cantitate=500
        self.assertEqual(f['candidate_site'], 'SITE-A')
        self.assertEqual(json.loads(f['evidence_json'])['commissionStatus'], 'rules_pending')

    def test_blank_and_shared_string_empty_never_activate(self):
        result, _ = self.load([row()], shared_empty=True)
        self.assertEqual(result['facts'], 0)
        self.assertEqual(result['sourceRows'], 1)

    def test_head_office_return_precedes_final_tr_attribution(self):
        self.load([row(), row(DocumentDetailId='RETURN', DataVDF='20250101', TR='SEDIU CENTRAL', SiteCode='NOM', Qtty='-1'),
                   row(DocumentDetailId='RESALE', DataVDF='20250201', SiteCode='SITE-B')])
        f = self.fact()
        self.assertEqual(f['candidate_site'], 'SITE-B')
        self.assertEqual(len(json.loads(f['evidence_json'])['returnLinks']), 1)
        self.assertEqual(f['net_quantity'], 1)

    def test_blank_activation_return_is_still_reconciled(self):
        self.load([row(), row(DocumentDetailId='RETURN', DataVDF='20250101', Activat='', DataActivare='', TR='SEDIU CENTRAL', Qtty='-1'),
                   row(DocumentDetailId='RESALE', DataVDF='20250201', SiteCode='SITE-B')])
        self.assertEqual(self.fact()['candidate_site'], 'SITE-B')

    def test_overlap_reupload_and_cross_file_returns(self):
        _, p = self.load([row()])
        before = a.summary(self.c)
        a.import_files(self.c, self.root / 'data', [p])
        self.assertEqual(a.summary(self.c), before)
        result, _ = self.load([row(), row(DocumentDetailId='RETURN', DataVDF='20250101', TR='SEDIU CENTRAL', Qtty='-1')])
        self.assertEqual(result['sourceRows'], 3)
        self.assertEqual(result['movementVersions'], 2)
        self.assertEqual(self.fact()['status'], 'unresolved')
        self.assertEqual(self.fact()['net_quantity'], 0)

    def test_changed_movement_is_preserved_and_blocks_candidate(self):
        self.load([row()])
        self.load([row(SiteCode='SITE-B')])
        self.assertEqual(a.summary(self.c)['movementVersions'], 2)
        self.assertIn('changed_source_movement', self.fact()['reasons'])
        self.assertIsNone(self.fact()['candidate_site'])

    def test_conflicting_activation_dates_have_no_month(self):
        self.load([row(), row(DocumentDetailId='OTHER', DataActivare='20260201')])
        self.assertIsNone(self.fact()['month'])
        self.assertIn('activation_date_conflict', self.fact()['reasons'])

    def test_post_activation_return_not_auto_payable(self):
        self.load([row(), row(DocumentDetailId='RETURN', DataVDF='20260401', Qtty='-1'),
                   row(DocumentDetailId='RESALE', DataVDF='20260402', SiteCode='SITE-B')])
        self.assertIsNone(self.fact()['candidate_site'])
        self.assertIn('post_activation_movement_rule_pending', self.fact()['reasons'])

    def test_ambiguous_customer_and_same_day_not_arbitrarily_matched(self):
        for change in ({'CodPunctDeLucru': 'UNKNOWN'}, {'DataVDF': '20240101'}):
            with self.subTest(change=change):
                rows = [row(), row(DocumentDetailId='RETURN', DataVDF='20250101', Qtty='-1', **{k:v for k,v in change.items() if k != 'DataVDF'})]
                rows[1].update(change)
                facts = a.reconcile_group([dict(zip(['movement_key','payload_hash','company','provider','imei','serial','movement_date','activation_date','site','agent','is_tr','item_code','item_type','customer_key','quantity','issues','raw_json'], a.normalized(r, 'hash', i)), id=i) for i,r in enumerate(rows)], set())
                self.assertIn('ambiguous_or_unmatched_return', facts[0][9])

    def test_tr_is_a_distinct_token_and_companies_remain_separate(self):
        self.load([row(TR='EXTRA', SiteCode='TR01'), row(Firma='OtherCo')])
        self.assertEqual(a.summary(self.c)['facts'], 2)
        self.assertEqual(self.c.execute("SELECT status FROM activation_facts WHERE company='ExampleCo'").fetchone()[0], 'unresolved')

    def test_invalid_date_or_serial_relationship_is_quarantined(self):
        self.load([row(DataActivare='20260230', Activat='123')])
        self.assertIsNone(self.fact()['month'])
        self.assertIn('invalid_DataActivare', self.fact()['reasons'])
        self.assertIn('unverified_serial_relationship', self.fact()['reasons'])

    def test_reordered_headers_supported_numeric_serial_rejected_atomically(self):
        self.load([row()], headers=list(reversed(a.HEADERS)))
        before = a.summary(self.c)
        with self.assertRaisesRegex(a.ImportError, 'Numeric serial'):
            self.load([row(DocumentDetailId='NEW')], numeric='IMEI')
        self.assertEqual(a.summary(self.c), before)

    def test_all_files_rollback_on_schema_error(self):
        good = fixture(self.root / 'good.xlsx', [row()])
        bad = fixture(self.root / 'bad.xlsx', [row()], headers=a.HEADERS[:-1] + ['Firma'])
        with self.assertRaisesRegex(a.ImportError, 'headers'):
            a.import_files(self.c, self.root / 'data', [good, bad])
        self.assertEqual(a.summary(self.c)['imports'], 0)
        self.assertEqual(a.summary(self.c)['movementVersions'], 0)
        self.assertEqual(self.c.execute('PRAGMA integrity_check').fetchone()[0], 'ok')

    def test_preview_preserves_existing_database(self):
        _, p = self.load([row()])
        before = a.summary(self.c)
        new = fixture(self.root / 'preview.xlsx', [row(DocumentDetailId='NEW')])
        result = subprocess.run([sys.executable, str(Path(a.__file__)), '--preview', '--data-dir', str(self.root / 'data'), str(new)], check=True, capture_output=True, text=True)
        self.assertTrue(json.loads(result.stdout)['preview'])
        self.assertEqual(a.summary(self.c), before)
        self.assertEqual(len(list((self.root / 'data' / 'activation-originals').glob('*.xlsx'))), 1)

    def test_unknown_product_and_historical_site_are_retained_without_payroll(self):
        self.load([row(ItemType='UNCLASSIFIED', SiteCode='HISTORICAL-SITE')])
        f = self.fact()
        self.assertEqual(f['item_type'], 'UNCLASSIFIED')
        self.assertEqual(f['candidate_site'], 'HISTORICAL-SITE')
        self.assertEqual(json.loads(f['evidence_json'])['employeeMapping'], 'unconfirmed')

    def test_same_site_return_resale_and_multiple_positive_sales(self):
        self.load([row(), row(DocumentDetailId='RETURN', DataVDF='20250101', Qtty='-1'),
                   row(DocumentDetailId='RESALE', DataVDF='20250201')])
        self.assertEqual(self.fact()['candidate_site'], 'SITE-A')
        self.load([row(DocumentDetailId='EXTRA', DataVDF='20250301')])
        self.assertIsNone(self.fact()['candidate_site'])
        self.assertEqual(self.fact()['net_quantity'], 2)

    def test_conflicting_imei_never_selects_a_site(self):
        self.load([row(), row(DocumentDetailId='OTHER', IMEI='0000000000000000011', SiteCode='SITE-B')])
        self.assertEqual(a.summary(self.c)['facts'], 1)
        self.assertIn('conflicting_imei_for_serial', self.fact()['reasons'])
        self.assertIsNone(self.fact()['net_quantity'])
        self.assertIsNone(self.fact()['item_code'])
        self.assertIsNone(self.fact()['candidate_site'])
        self.assertEqual(len(json.loads(self.fact()['evidence_json'])['movementIds']), 2)

    def test_same_imei_different_activation_serials_are_conflicts(self):
        self.load([row(), row(DocumentDetailId='OTHER', Activat='000000000000000002')])
        self.assertEqual(a.summary(self.c)['facts'], 2)
        for f in self.c.execute('SELECT * FROM activation_facts'):
            self.assertIn('serial_identity_conflict', f['reasons'])
            self.assertIsNone(f['candidate_site'])

    def test_whitespace_activation_is_blank(self):
        self.load([row(Activat='   ')])
        self.assertEqual(a.summary(self.c)['facts'], 0)

    def test_bad_signed_quantity_and_missing_identity_not_candidates(self):
        self.load([row(Qtty='2', Furnizor='', DocumentDetailId='')])
        f = self.fact()
        self.assertIn('unsupported_quantity', f['reasons'])
        self.assertIn('missing_identity', f['reasons'])
        self.assertIn('missing_movement_identity', f['reasons'])
        self.assertIsNone(f['candidate_site'])

    def test_missing_original_is_not_reported_as_successful_reupload(self):
        result, path = self.load([row()])
        archived = self.root / 'data' / 'activation-originals' / (result['files'][0]['sha256'] + '.xlsx')
        archived.unlink()
        before = a.summary(self.c)
        with self.assertRaisesRegex(a.ImportError, 'Archived source'):
            a.import_files(self.c, self.root / 'data', [path])
        self.assertEqual(a.summary(self.c), before)

    def test_directory_mismatch_refused(self):
        path = fixture(self.root / 'input.xlsx', [row()])
        with self.assertRaisesRegex(a.ImportError, 'directory'):
            a.import_files(self.c, self.root / 'other', [path])

    def test_exact_decimal_quantity_without_float_coercion(self):
        self.load([row(Qtty='1.0')])
        self.assertEqual(self.fact()['net_quantity'], 1)
        self.assertEqual(self.fact()['candidate_site'], 'SITE-A')
        for value in ('NaN', 'Infinity', '1.000000000000001', '0'):
            with self.subTest(value=value):
                parsed = a.normalized(row(Qtty=value), 'hash', 6)
                self.assertIsNone(parsed[14])

    def test_unknown_schema_refused(self):
        self.c.execute("UPDATE activation_meta SET value='999'")
        self.c.commit()
        with self.assertRaisesRegex(a.ImportError, 'schema version'):
            a.connect(self.root / 'data')

if __name__ == '__main__':
    unittest.main()
