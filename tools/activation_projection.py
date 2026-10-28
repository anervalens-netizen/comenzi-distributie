"""Indexed private activation/cohort detail used by all authorized read surfaces."""
import hashlib
import json
from client_sales_history import cui_key,code_key
from client_catalog_plan import county_key


def validate_rules(rules):
    if rules is None:return
    groups={'vodafone_0','vodafone_3','vodafone_5','vodafone_credit','digi','accessories','varta','scent','unmapped'}
    if not isinstance(rules,dict) or rules.get('version')!=1 or not isinstance(rules.get('revision'),str) or not rules['revision'].strip() or rules.get('history')!='all' or not isinstance(rules.get('assignments'),list) or not isinstance(rules.get('products'),dict):raise ValueError('Invalid distribution rules')
    users=set();sites=set()
    for a in rules['assignments']:
        if not isinstance(a,dict) or any(not isinstance(a.get(k),str) or not a[k].strip() or a[k]!=a[k].strip() for k in ['userId','siteCode']):raise ValueError('Invalid distribution identity')
        if a['userId'] in users or a['siteCode'].upper() in sites:raise ValueError('Ambiguous distribution identity')
        users.add(a['userId']);sites.add(a['siteCode'].upper())
        allowed={'vodafone_sud':{'sud'},'vodafone_nord':{'nord_a','nord_b'},'non_exclusiv':{None}}
        if a.get('territoryId') not in allowed.get(a.get('projectId'),set()) or not isinstance(a.get('counties'),list) or any(not isinstance(v,str) or not county_key(v.removeprefix('RO-')) for v in a['counties']):raise ValueError('Invalid project territory')
    if any(not isinstance(k,str) or not k.strip() or k!=k.strip() or v not in groups for k,v in rules['products'].items()):raise ValueError('Invalid product mapping')


def build_details(source,target):
    target.executescript('''
      CREATE TABLE details(id TEXT PRIMARY KEY,company TEXT NOT NULL,provider TEXT NOT NULL,serial TEXT NOT NULL,
        activation_date TEXT,month TEXT,site TEXT NOT NULL,item_type TEXT NOT NULL,item_code TEXT NOT NULL,
        county TEXT NOT NULL,handset TEXT NOT NULL,contradictory INTEGER NOT NULL,point_key TEXT NOT NULL,
        client_code TEXT NOT NULL,point_code TEXT NOT NULL,label TEXT NOT NULL,distribution_date TEXT,
        status TEXT NOT NULL,reasons TEXT NOT NULL,is_tr INTEGER NOT NULL);
      CREATE INDEX detail_scope ON details(provider,site,month,activation_date);
      CREATE INDEX detail_month ON details(provider,month,site);
      CREATE INDEX detail_point ON details(point_key,provider,is_tr,month,site,activation_date);
      CREATE INDEX detail_recent ON details(provider,activation_date,site,point_key);
      CREATE TABLE cohorts(id TEXT PRIMARY KEY,company TEXT NOT NULL,provider TEXT NOT NULL,site TEXT NOT NULL,
        item_code TEXT NOT NULL,distribution_month TEXT NOT NULL,distribution_date TEXT NOT NULL,activated INTEGER NOT NULL);
      CREATE INDEX cohort_scope ON cohorts(provider,distribution_month,site,item_code);
    ''')
    insert_details(source,target)
    target.executescript('''CREATE INDEX detail_company_scope ON details(provider,company,client_code,is_tr,month,site,activation_date);
      CREATE TABLE dimension_monthly AS SELECT provider,month,site,item_type,county,handset,contradictory,is_tr,COUNT(*) count,MAX(activation_date) last_date FROM details GROUP BY provider,month,site,item_type,county,handset,contradictory,is_tr;
      CREATE INDEX dimension_scope ON dimension_monthly(provider,site,month);
      CREATE INDEX dimension_month ON dimension_monthly(provider,month);''')
    # Cohorts include unactivated SIMs; retain only a sole net-positive TR survivor after exact returns.
    insert_cohorts(source,target)


def insert_details(source,target,where='',params=()):
    source.row_factory=__import__('sqlite3').Row
    for f in source.execute('SELECT f.*,EXISTS(SELECT 1 FROM activation_effective_movements m WHERE m.company=f.company AND m.provider=f.provider AND m.serial=f.serial AND m.is_tr=1) is_tr FROM activation_facts f' + where, params):
        evidence=json.loads(f['evidence_json']);observation=evidence.get('observation',{})
        remaining=evidence.get('remainingSaleIds',[])
        m=source.execute('SELECT * FROM activation_movements WHERE id=?',(remaining[0],)).fetchone() if len(remaining)==1 else None
        raw=json.loads(m['raw_json']) if m else {}
        client=cui_key(raw.get('CIF',''));point=code_key(raw.get('CodPunctDeLucru',''))
        # Same stable source identity conventions as client-sales; no name/address guesses.
        point_key=json.dumps([f['company'],client,point],separators=(',',':')) if client and point else ''
        ident=hashlib.sha256(json.dumps([f['company'],f['provider'],f['serial']],separators=(',',':')).encode()).hexdigest()
        if m and not m['is_tr'] and 'remaining_movement_not_tr' in json.loads(f['reasons']):
            f=dict(f);f['is_tr']=0
        contradictory=any(r in json.loads(f['reasons']) for r in ('county_conflict','handset_conflict','activation_date_conflict','serial_conflict','serial_identity_conflict','conflicting_imei_for_serial'))
        target.execute('INSERT INTO details VALUES('+','.join('?'*20)+')',(ident,f['company'],f['provider'],f['serial'],f['activation_date'],f['month'],f['candidate_site'] or '',f['item_type'] or 'OTHER',f['item_code'] or '',observation.get('county',''),observation.get('handset',''),int(contradictory),point_key,client,point,raw.get('Denumire Client','') or ('Partener generic / persoane fizice' if client=='CLIENTGEN' else 'Punct de verificat'),m['movement_date'] if m else None,f['status'],f['reasons'],f['is_tr']))


def insert_cohorts(source,target,where='',params=()):
    source.row_factory=__import__('sqlite3').Row
    query='SELECT * FROM activation_effective_movements' + where + ' ORDER BY company,provider,imei,movement_id'
    import itertools
    for _,group in itertools.groupby(source.execute(query, params),key=lambda r:(r['company'],r['provider'],r['imei'])):
        rows=list(group);outstanding=[];invalid=False
        for candidate in rows:
            original=source.execute('SELECT issues,movement_key FROM activation_movements WHERE id=?',(candidate['movement_id'],)).fetchone()
            if json.loads(original['issues']):invalid=True
            # Equal-revision commercial conflicts are recorded even for unactivated groups.
            if source.execute("SELECT 1 FROM activation_meta WHERE key=?",('conflict:'+original['movement_key'],)).fetchone():invalid=True
        for r in sorted(rows,key=lambda r:(r['movement_date'] or '',r['movement_id'])):
            if r['quantity']==1:outstanding.append(r)
            elif r['quantity']==-1:
                matches=[p for p in outstanding if r['customer_key'] and p['customer_key']==r['customer_key'] and p['item_code']==r['item_code'] and p['movement_date'] and r['movement_date'] and p['movement_date']<r['movement_date']]
                if len(matches)==1:outstanding.remove(matches[0])
                else:invalid=True
            else:invalid=True
        if invalid or len(outstanding)!=1 or sum(r['quantity'] or 0 for r in rows)!=1:continue
        r=outstanding[0]
        if not r['is_tr'] or not r['site'] or not r['movement_date']:continue
        # An attribution conflict may never create a confident cohort.
        fact=source.execute('SELECT status,activation_date,reasons FROM activation_facts WHERE company=? AND provider=? AND serial=?',(r['company'],r['provider'],r['serial'])).fetchone() if r['serial'] else None
        # A known activation before a later distribution is an attribution exception,
        # not a second activation or a reason to erase a uniquely reconciled cohort member.
        if fact and fact['status']!='candidate' and json.loads(fact['reasons'])!=['post_activation_movement_rule_pending']:continue
        ident=hashlib.sha256(json.dumps([r['company'],r['provider'],r['imei']],separators=(',',':')).encode()).hexdigest()
        target.execute('INSERT INTO cohorts VALUES(?,?,?,?,?,?,?,?)',(ident,r['company'],r['provider'],r['site'],r['item_code'],r['movement_date'][:7],r['movement_date'],int(bool(fact and fact['activation_date']))))
