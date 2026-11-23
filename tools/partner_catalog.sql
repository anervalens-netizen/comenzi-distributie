CREATE TEMP VIEW catalog_companies AS
SELECT partner_id company_id, name, cif, partner_code, source_hash FROM crm.crm_companies;

CREATE TEMP TABLE catalog_fiscal AS
SELECT fiscal_key(cif) fiscal_id, MIN(company_id) company_id FROM catalog_companies
WHERE fiscal_key(cif) IS NOT NULL GROUP BY fiscal_key(cif) HAVING COUNT(*)=1;
CREATE UNIQUE INDEX temp.catalog_fiscal_id ON catalog_fiscal(fiscal_id);

CREATE TEMP TABLE catalog_ambiguous_fiscal AS
SELECT fiscal_key(cif) fiscal_id FROM catalog_companies WHERE fiscal_key(cif) IS NOT NULL
GROUP BY fiscal_key(cif) HAVING COUNT(*)>1;
CREATE UNIQUE INDEX temp.catalog_ambiguous_fiscal_id ON catalog_ambiguous_fiscal(fiscal_id);

CREATE TEMP TABLE catalog_client_codes AS
SELECT upper(trim(partner_code)) client_code, min(company_id) company_id FROM catalog_companies
WHERE length(trim(partner_code))>0 AND upper(trim(partner_code)) NOT IN ('CLIENTGEN','GENERICPARTENER','GENERICPARTNER')
  AND trim(partner_code) GLOB '*[0-9A-Za-z]*'
GROUP BY upper(trim(partner_code)) HAVING count(*)=1;
CREATE UNIQUE INDEX temp.catalog_client_code ON catalog_client_codes(client_code);

CREATE TEMP TABLE catalog_portfolio AS
SELECT c.id customer_id, c.active, json_extract(c.data,'$.name') name,
       json_extract(c.data,'$.city') city, json_extract(c.data,'$.county') county,
       json_extract(c.data,'$.address') address, json_extract(c.data,'$.cui') source_client_code,
       CASE WHEN COUNT(l.address_id)=1 AND MAX(CASE WHEN fiscal_key(json_extract(c.data,'$.cui')) IS NOT NULL
              AND fiscal_key(co.cif) IS NOT NULL AND fiscal_key(json_extract(c.data,'$.cui'))<>fiscal_key(co.cif)
              THEN 1 ELSE 0 END)=0 THEN 'crm:'||MIN(l.address_id) ELSE 'portfolio:'||c.id END point_key,
       CASE WHEN COUNT(l.address_id)>1 THEN 'multiple CRM addresses'
            WHEN COUNT(l.address_id)=0 THEN 'portfolio only'
            WHEN fiscal_key(json_extract(c.data,'$.cui')) IS NOT NULL AND fiscal_key(MIN(co.cif)) IS NOT NULL
             AND fiscal_key(json_extract(c.data,'$.cui'))<>fiscal_key(MIN(co.cif)) THEN 'conflicting fiscal identifiers'
            ELSE MIN(l.method) END evidence
FROM crm.customers c LEFT JOIN crm.crm_customer_links l ON l.customer_id=c.id
LEFT JOIN crm.crm_locations p ON p.address_id=l.address_id
LEFT JOIN catalog_companies co ON co.company_id=p.partner_id GROUP BY c.id;
CREATE UNIQUE INDEX temp.catalog_portfolio_id ON catalog_portfolio(customer_id);
CREATE INDEX temp.catalog_portfolio_point ON catalog_portfolio(point_key);

CREATE TEMP VIEW catalog_points AS
SELECT 'crm:'||address_id point_key, partner_id company_id, franchise_code, synthetic_name name, city, county,
       trim(street||' '||local_number) address, 'crm' source FROM crm.crm_locations
UNION ALL
SELECT p.point_key, f.company_id, NULL, p.name, p.city, p.county, p.address, 'portfolio'
FROM catalog_portfolio p LEFT JOIN catalog_fiscal f ON f.fiscal_id=fiscal_key(p.source_client_code)
WHERE p.point_key='portfolio:'||p.customer_id;

CREATE TEMP VIEW catalog_erp_identity AS
WITH owners AS (
  SELECT i.id identity_id, i.client_code, i.franchise_code,
         CASE WHEN af.fiscal_id IS NOT NULL THEN NULL
              WHEN f.company_id IS NOT NULL AND k.company_id IS NOT NULL AND f.company_id<>k.company_id THEN NULL
              WHEN f.company_id IS NOT NULL THEN f.company_id
              WHEN fiscal_key(i.client_code) IS NULL OR fiscal_key(co.cif) IS NULL
                OR fiscal_key(co.cif)=fiscal_key(i.client_code) THEN k.company_id END company_id
  FROM history.history_identities i LEFT JOIN catalog_fiscal f ON f.fiscal_id=fiscal_key(i.client_code)
  LEFT JOIN catalog_ambiguous_fiscal af ON af.fiscal_id=fiscal_key(i.client_code)
  LEFT JOIN catalog_client_codes k ON k.client_code=upper(trim(i.client_code))
  LEFT JOIN catalog_companies co ON co.company_id=k.company_id
)
SELECT i.*, CASE WHEN i.company_id=p.partner_id THEN 'crm:'||p.address_id END point_key,
       CASE WHEN i.company_id=p.partner_id THEN 'client identifier and franchise'
            WHEN i.company_id IS NOT NULL THEN 'client identifier only'
            WHEN p.address_id IS NOT NULL THEN 'franchise without confirmed owner'
            WHEN upper(trim(i.client_code)) IN ('CLIENTGEN','GENERICPARTENER','GENERICPARTNER') THEN 'generic receipt'
            ELSE 'no confirmed CRM identity' END evidence
FROM owners i LEFT JOIN crm.crm_locations p ON p.franchise_code=i.franchise_code AND i.franchise_code<>'';

CREATE TEMP VIEW catalog_erp_sales AS
SELECT r.import_id, r.sheet, r.source_row, r.date, r.document_number, r.identity_id, r.item_code,
       r.quantity_micros, r.value_cents, e.company_id, e.point_key, e.evidence
FROM history.history_rows r JOIN history.history_imports i ON i.id=r.import_id AND i.state='active'
JOIN catalog_erp_identity e ON e.identity_id=r.identity_id;

CREATE TEMP TABLE catalog_seller_sites AS
SELECT upper(trim(site_code)) site, min(warehouse_id) current_warehouse_id
FROM crm.users WHERE active=1 AND role='agent' AND trim(site_code)<>'' AND trim(warehouse_id)<>''
GROUP BY upper(trim(site_code)) HAVING count(DISTINCT warehouse_id)=1;
CREATE UNIQUE INDEX temp.catalog_seller_sites_key ON catalog_seller_sites(site);

CREATE TEMP VIEW catalog_agent_sales AS
SELECT r.import_id, r.row_number, r.date, r.site_code, s.current_warehouse_id, r.item_code, r.quantity, r.value_cents
FROM seller.sales_rows r JOIN seller.sales_months m ON m.import_id=r.import_id AND m.month=r.month
LEFT JOIN catalog_seller_sites s ON s.site=upper(trim(r.site_code));

CREATE TEMP VIEW catalog_vodafone_movements AS
SELECT v.movement_id, v.movement_date, v.site, v.is_tr, v.item_code, v.quantity, f.company_id,
       CASE WHEN f.company_id=p.partner_id THEN 'crm:'||p.address_id END point_key
FROM vodafone.activation_effective_movements v
LEFT JOIN catalog_fiscal f ON f.fiscal_id=fiscal_key(json_extract(v.raw_json,'$.CIF'))
LEFT JOIN crm.crm_locations p ON p.franchise_code=upper(trim(json_extract(v.raw_json,'$.CodPunctDeLucru')))
 AND trim(json_extract(v.raw_json,'$.CodPunctDeLucru'))<>'';

CREATE TEMP VIEW catalog_digi_movements AS
SELECT d.movement_id, d.movement_date, d.site, d.is_tr, d.item_code, d.quantity, s.current_warehouse_id,
       json_extract(d.raw_json,'$."Denumire Client"') reported_customer_name
FROM digi.activation_effective_movements d LEFT JOIN catalog_seller_sites s ON s.site=upper(trim(d.site));

CREATE TEMP VIEW catalog_delivery_points AS
SELECT o.id order_id,o.kind,o.finalized_at,
       CASE WHEN fiscal_key(json_extract(o.payload,'$.client.cui')) IS NOT NULL AND
                 fiscal_key(p.source_client_code)=fiscal_key(json_extract(o.payload,'$.client.cui'))
            THEN p.point_key END point_key,
       json_extract(o.payload,'$.client.cui') recorded_client_code, json_extract(o.payload,'$.client.id') recorded_customer_id
FROM crm.orders o LEFT JOIN crm.customer_identity_aliases a ON a.alias_id=json_extract(o.payload,'$.client.id')
LEFT JOIN catalog_portfolio p ON p.customer_id=COALESCE(a.canonical_id,json_extract(o.payload,'$.client.id'))
WHERE o.status='finalized' AND o.kind IN ('sim','stand_client');
