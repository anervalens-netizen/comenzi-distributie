"""Corroborate historical ERP document parties against the commercial SIM register."""
import json
from collections import defaultdict


def label(value):
    return ' '.join(str(value or '').upper().split())


def identifier(value):
    raw = label(value)
    return raw[2:] if raw.startswith('RO') and raw[2:].isascii() and raw[2:].isdigit() else raw


def valid_identifier(value):
    return bool(value and any(c.isalnum() for c in value))


def trace_documents(db, identity_ids):
    """One result per active ERP line. A shared document can contain other items."""
    ids = sorted(set(identity_ids))
    if not ids:
        return []
    marks = ','.join('?' for _ in ids)
    sales = db.execute(f"""SELECT r.import_id, r.sheet, r.source_row, r.identity_id, r.date,
           r.site_id, r.document_number, r.customer_name, e.client_code, e.franchise_code,
           r.item_code, r.value_cents, e.company_id, e.point_key
        FROM history.history_rows r JOIN history.history_imports i ON i.id=r.import_id AND i.state='active'
        JOIN catalog_erp_identity e ON e.identity_id=r.identity_id WHERE r.identity_id IN ({marks})
        ORDER BY r.identity_id,r.date,r.import_id,r.sheet,r.source_row""", ids).fetchall()
    if not sales:
        return []
    wanted = {(r['date'], label(r['site_id']), label(r['document_number'])) for r in sales
              if valid_identifier(label(r['site_id'])) and valid_identifier(label(r['document_number']))}
    parties = defaultdict(set)
    issuers = defaultdict(set)
    counts = defaultdict(int)
    if wanted:
        dates = [k[0] for k in wanted]
        for r in db.execute("""SELECT movement_date,company,raw_json FROM vodafone.activation_effective_movements
                               WHERE movement_date BETWEEN ? AND ?""", (min(dates),max(dates))):
            raw = json.loads(r['raw_json'])
            key = (r['movement_date'], label(raw.get('SiteId')), label(raw.get('Nr')))
            if key not in wanted:
                continue
            counts[key] += 1
            issuers[key].add(label(r['company']))
            parties[key].add((identifier(raw.get('CIF')), label(raw.get('CodPunctDeLucru')), label(raw.get('Denumire Client'))))
    results = []
    for sale in sales:
        key = (sale['date'], label(sale['site_id']), label(sale['document_number']))
        expected = (identifier(sale['client_code']), label(sale['franchise_code']), label(sale['customer_name']))
        observed = parties.get(key, set())
        if not observed:
            state = 'no matching document'
        elif len(observed) != 1 or len(issuers[key]) != 1 or '' in issuers[key]:
            state = 'ambiguous document'
        elif all(valid_identifier(x) for x in expected) and observed == {expected}:
            state = 'historical client and point corroborated'
        else:
            state = 'document without matching verified identifiers'
        results.append({**dict(sale), 'document_evidence': state, 'source_movements': counts.get(key, 0)})
    return results
