import type { ManagerAiCell, ManagerAiCoverage } from './manager-ai';

export type ManagerAiAnalysisColumn = { name: string; type: 'text' | 'number'; nullable: boolean };
const t = (name: string, nullable = true): ManagerAiAnalysisColumn => ({ name, type:'text', nullable });
const n = (name: string, nullable = true): ManagerAiAnalysisColumn => ({ name, type:'number', nullable });
const month = t('month', false), day = t('date', false), site = t('site_code'), sku = t('sku');
const product = t('product'), franchise = t('franchise_code'), partner = t('partner'), warehouse = t('warehouse');
const units = n('units'), count = n('activations', false), status = t('status'), doc = t('document_ref');
const pointRef = t('point_ref');
const allCategories = 'Include toate categoriile din sursă. product_group=unmapped indică un cod fără clasificare în catalog.';
const provider = t('provider', false), note = t('source', false), catalogGroup = t('product_group');

export const managerAiAnalysisCatalog = {
  sales_team_monthly: {
    label:'Vânzări și efectiv pe manager, proiect și agent',
    grain:'Lună × apartenență curentă agent–manager × grupă comercială. Include agenții activi eligibili fără vânzări, cu zero numai când sursa este disponibilă. Un agent comun poate apărea la mai mulți manageri. Pentru total transversal deduplică pe agent_ref, lună și product_group. Proiectele sunt vodafone_sud, vodafone_nord, non_exclusiv; NULL indică atribuirea necunoscută. value_cents este valoarea cu TVA în bani, value_ex_vat_lei valoarea fără TVA în lei pentru accesorii, Varta și odorizante. _coverage și source_through indică acoperirea sursei. MAX(agent_last_sale) indică ultima vânzare observată în echipele selectate.',
    columns:[month,t('manager_ref'),t('manager'),t('agent_ref',false),t('agent'),t('project_id'),t('product_group',false),units,n('value_cents'),n('value_ex_vat_lei'),n('missing_value_rows'),t('source_through'),t('agent_last_sale')],
  },
  sales_lines: {
    label:'Vânzări comerciale pe linii',
    grain:'O linie din importul lunar activ sau din istoricul cu acoperire completă, pe zi, gestiune și SKU. Sursele nu se adună pentru aceeași lună. Valoarea sursă este în bani. '+allCategories,
    columns:[month,day,site,warehouse,sku,product,t('brand'),t('category'),t('subcategory'),catalogGroup,units,n('value_cents'),note],
  },
  sales_partner_lines: {
    label:'Vânzări istorice legate univoc de puncte',
    grain:'O linie din istoricul comercial cu franciză confirmată. Subset independent al istoricului, posibil suprapus cu sales_lines. Valoarea sursă este în bani. Leagă punctele prin point_ref pentru a include codurile alternative confirmate. '+allCategories,
    columns:[month,day,t('point_ref',false),franchise,partner,t('erp_site_id'),doc,sku,product,units,n('value_cents'),catalogGroup],
  },
  activation_detail: {
    label:'Activări pe zi și produs',
    grain:'Zi × operator × gestiune × cod produs × tip × județ × sursă × conflict. Activări interne atribuite distribuției.',
    columns:[month,day,provider,site,sku,t('item_type'),t('county'),t('activation_channel'),n('conflict',false),count,catalogGroup],
  },
  activation_monthly: {
    label:'Activări pe lună și gestiune',
    grain:'Lună × operator × gestiune, cu sursa Digi oficială când este disponibilă și autorizată.',
    columns:[month,provider,site,note,count,n('sim'),n('phone_bundles'),n('other'),n('unassigned')],
  },
  activation_sim0_clients: {
    label:'Activări SIM 0 Vodafone pe firme și puncte identificate',
    grain:'O lună × CUI valid din catalogul de firme × punct de lucru atribuit univoc. Clientul generic, CUI-ul nevalid și punctele incerte sunt excluse; vezi _coverage. În selecții restrânse, cifrele însumează numai contribuțiile vizibile la fiecare firmă și punct. Acoperirea incompletă permite numai clasamentul observațiilor disponibile. Sortează firmele după SUM(activations) pe cui și partner, iar punctele separat după franchise_code. confirmed_activations numără activările cu document comercial confirmat.',
    columns:[month,t('cui',false),t('partner',false),t('franchise_code',false),count,n('confirmed_activations',false)],
  },
  activation_partners: {
    label:'Activări pe punct de lucru',
    grain:'Lună × operator × identitate proiectată. Același punct poate apărea în mai multe rânduri. point_ref este prezent pentru corespondențe univoce în portofoliul autorizat. Surse interne.',
    columns:[month,provider,pointRef,franchise,partner,t('identity'),count],
  },
  partners: {
    label:'Portofoliu de puncte de lucru',
    grain:'Un punct activ din portofoliul vizibil la data extragerii. franchise_code este codul principal. Folosește point_ref pentru legarea codurilor alternative confirmate.',
    columns:[t('point_ref',false),partner,franchise,t('county'),t('city'),t('last_visit_date'),n('points',false)],
  },
  orders: {
    label:'Comenzi operaționale',
    grain:'O poziție de produs sau un rând cu totalul sim_zero_units pe document. units măsoară doar pozițiile de produs. Avizele pentru standuri la client sunt în stands. Data indică finalizarea sau crearea ciornei. '+allCategories,
    columns:[month,day,doc,warehouse,sku,product,t('kind'),status,units,n('sim_zero_units'),catalogGroup],
  },
  stock: {
    label:'Stocul importat curent',
    grain:'Ultima observație pe SKU și gestiune, cu data observării. Situația este curentă. '+allCategories,
    columns:[warehouse,site,sku,product,t('category'),t('observed_on'),units,catalogGroup],
  },
  inventories: {
    label:'Inventare finalizate',
    grain:'O poziție dintr-un inventar finalizat. '+allCategories,
    columns:[month,day,warehouse,sku,product,n('expected'),n('counted'),n('difference'),catalogGroup],
  },
  transfers: {
    label:'Transferuri finalizate',
    grain:'O poziție dintr-un transfer cu sursa în selecția autorizată. Destinațiile din afara selecției sunt omise. '+allCategories,
    columns:[month,day,doc,warehouse,t('destination'),sku,product,units,catalogGroup],
  },
  stands: {
    label:'Avize de stand',
    grain:'O poziție dintr-un aviz de stand la client finalizat în aplicație. Comenzile de standuri pentru stoc sunt în orders.',
    columns:[month,day,doc,partner,warehouse,sku,product,units],
  },
  bonuses: {
    label:'Registru Vodafone de bonusuri',
    grain:'O franciză și o lună de activări, cu starea aprobării și soldul de bonus.',
    columns:[month,franchise,partner,status,count,n('target'),n('bonus_sim5'),n('bonus_top'),n('total_bonus'),n('settled'),n('balance'),n('simulated_settled'),n('simulated_balance')],
  },
  bonus_documents: {
    label:'Documente de bonus Vodafone',
    grain:'Un document fiscal candidat sau confirmat, după luna emiterii.',
    columns:[month,day,doc,site,franchise,partner,status,units],
  },
  bonus_unresolved: {
    label:'Activări SIM 0 neclarificate',
    grain:'O grupă de activări fără identitate confirmată, cu motiv și gestiune.',
    columns:[month,site,status,count],
  },
  settlements: {
    label:'Alocări de bonusuri Vodafone',
    grain:'O alocare de bonus dintr-un document de plată, raportată la luna premiului.',
    columns:[month,t('payment_date',false),doc,site,franchise,t('kind'),status,units],
  },
  focus_accessories: {
    label:'Incentive Focus accesorii',
    grain:'Lună × agent × produs, pe grila aplicabilă.',
    columns:[month,t('seller'),site,sku,product,units,n('incentive_lei')],
  },
  focus_phones: {
    label:'Incentive Focus telefoane',
    grain:'Lună × agent × produs, pe grila aplicabilă.',
    columns:[month,t('seller'),site,sku,product,units,n('incentive_lei')],
  },
  focus_targets: {
    label:'Ținte Focus telefoane',
    grain:'Lună × agent, cu ținta și realizarea grilei.',
    columns:[month,t('seller'),site,units,n('target'),n('incentive_lei'),status],
  },
} as const;

export type ManagerAiAnalysisDataset = keyof typeof managerAiAnalysisCatalog;
export type ManagerAiAnalysisRequest = {table: ManagerAiAnalysisDataset; fromMonth:string; toMonth:string};
export type ManagerAiAnalysisTable = ManagerAiAnalysisRequest & {
  columns: readonly ManagerAiAnalysisColumn[];
  rows: readonly (readonly ManagerAiCell[])[];
  coverage: readonly ManagerAiCoverage[];
};
export const managerAiAnalysisLimits = {rows:80_000, textBytes:12*1024*1024, cellBytes:4096, sqliteBytes:24*1024*1024, tables:6, months:12} as const;
