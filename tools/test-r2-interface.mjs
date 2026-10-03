// Self-contained synthetic fixture: real route/auth/SQL modules and rendered UI.
// No listener, fixed port, resource mutation, app build, or external service.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const require=createRequire(import.meta.url),dir=mkdtempSync(join(tmpdir(),'r2-interface-'));
const sqlite=new DatabaseSync(':memory:');
let checks=0;
const check=(value,label)=>{assert.ok(value,label);checks++;};
const equal=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
const adapter={prepare(sql){return {args:[],bind(...args){this.args=args;return this;},async all(){return {results:sqlite.prepare(sql).all(...this.args)};},async first(){return sqlite.prepare(sql).get(...this.args)||null;},async run(){return this.execute();},execute(){return {meta:sqlite.prepare(sql).run(...this.args)};}};},async batch(statements){sqlite.exec('BEGIN');try{const result=statements.map(s=>s.execute());sqlite.exec('COMMIT');return result;}catch(error){sqlite.exec('ROLLBACK');throw error;}}};
globalThis.__r2Db=adapter;
const unused=names=>names.map(name=>`export const ${name}=()=>{throw new Error('Unexpected infrastructure call: ${name}');};`).join('\n');
const stubs={
  runtime:'export const env={DB:globalThis.__r2Db};export const runtimeKind="standalone";'+unused(['operationalStatus']),
  catalog:'export const readCatalog=async()=>({products:[]});'+unused(['changeProduct']),
  'stock-server':`export const stockForWarehouse=async()=>({importedAt:'2026-09-01T00:00:00Z',filename:'synthetic.xlsx',rows:[{code:'SYNTHETIC',name:'Synthetic product',quantity:10}]});${unused(['stockImportStatus','stockView','stockUpload'])}`,
  'sales-server':unused(['salesImportStatus','salesView','salesUpload']),
  exports:unused(['templateExport','combinedExport','repairOrderExport','simExport','mailFor','emlFor']),
  'push-notifications':unused(['managerRequestInbox','pushPublicConfig','removePushSubscription','upsertPushSubscription','sendPartnerRequestPush']),
  'partner-mail':unused(['partnerMail']),
  'partner-planning':unused(['visitWeek','saveDayPlan']),
  'partner-map-api':unused(['browsePartners','mapPartners']),
  'client-import-server':unused(['importClients']),
  // This in-memory route fixture must not load the host-only upload worker.
  // Its real filesystem/HTTP import contract is exercised by its own suite.
  'client-history-import-runtime':unused(['historyImportStatus','historyImportPreview','historyImportCommit']),
};
const serverPlugin={name:'synthetic-infrastructure',setup(b){
  b.onResolve({filter:/^(?:@\/lib\/|\.\/)([^/]+)$/},args=>{const name=args.path.split('/').at(-1);if(name in stubs)return {path:name,namespace:'fixture'};});
  b.onResolve({filter:/^@\/resources\//},args=>({path:args.path.split('/').at(-1),namespace:'resource'}));
  b.onLoad({filter:/.*/,namespace:'fixture'},args=>({loader:'js',contents:stubs[args.path]}));
  b.onLoad({filter:/.*/,namespace:'resource'},args=>({loader:'json',contents:JSON.stringify(args.path==='seed.json'?{products:[],clients:[],warehouses:[],importWarnings:[]}:args.path==='initial-users.json'?[]:{})}));
}};
async function load(entry,plugins,name=entry.replace(/\W/g,'_')){const outfile=join(dir,name+'.mjs');await build({entryPoints:[entry],outfile,bundle:true,platform:'node',format:'esm',banner:{js:"import {createRequire as fixtureRequire} from 'node:module';const require=fixtureRequire(import.meta.url);"},plugins,logLevel:'silent'});return import(pathToFileURL(outfile));}
const noOp=()=>{};
try {
  for(const file of readdirSync('drizzle').filter(f=>f.endsWith('.sql')).sort())sqlite.exec(readFileSync(join('drizzle',file),'utf8'));
  sqlite.prepare('INSERT INTO settings VALUES(?,?)').run('seed-v1','1');
  const accounts=[['regional','manager',null,1,'assigned'],['global','manager',null,1,'global'],['region-b','manager',null,1,'assigned'],['a','agent','w-a',1,'assigned'],['a-shared','agent','w-a',1,'assigned'],['inactive','agent','w-inactive',0,'assigned'],['b','agent','w-b',1,'assigned']];
  const cookies={};
  for(const [id,role,warehouse,active,scope] of accounts){
    sqlite.prepare('INSERT INTO users(id,username,name,role,warehouse_id,warehouse_name,active,manager_scope,password_hash,must_change_password) VALUES(?,?,?,?,?,?,?,?,?,0)').run(id,id,'Synthetic '+id,role,warehouse,warehouse,active,scope,'unused');
    const token=randomUUID();cookies[id]='mobiup_session='+token;
    sqlite.prepare('INSERT INTO sessions VALUES(?,?,?)').run(createHash('sha256').update(token).digest('hex'),id,Date.now()+3600000);
  }
  for(const [manager,agent] of [['regional','a'],['regional','a-shared'],['regional','inactive'],['region-b','b'],['region-b','a-shared']])sqlite.prepare('INSERT INTO manager_agents VALUES(?,?)').run(manager,agent);
  const route=await load('app/api/[...path]/route.ts',[serverPlugin]);
  const server=await load('lib/server.ts',[serverPlugin]);
  const activity=await load('lib/partner-requests.ts',[serverPlugin]);
  const {writePermissions}=await load('lib/types.ts',[]);
  const users=accounts.map(([id])=>({...server.userView(sqlite.prepare('SELECT * FROM users WHERE id=?').get(id)),managedAgentIds:sqlite.prepare('SELECT agent_id FROM manager_agents WHERE manager_id=?').all(id).map(row=>row.agent_id)}));
  const user=id=>users.find(row=>row.id===id);
  async function api(path,who='regional',method='GET',body,status=200){
    const request=new Request('http://localhost/api/'+path,{method,headers:{Cookie:cookies[who]||'','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    const response=await route[method](request),data=await response.json();
    equal(response.status,status,`${method} ${path}: ${JSON.stringify(data).slice(0,300)}`);return data;
  }
  // The client helper matches actual server authorization, including inactive and shared assignments.
  for(const account of users){
    const permissions=writePermissions(account,users);
    for(const target of users.filter(u=>u.role==='agent'))equal(permissions.agent(target.id),await server.canAccessAgent(account,target.id),'agent permission parity');
    for(const warehouse of ['w-a','w-b','w-inactive'])equal(permissions.warehouse(warehouse),await server.canAccessWarehouse(account,warehouse),'warehouse permission parity');
  }
  check(!writePermissions(null,users).agent('a'),'unknown identity fails closed');
  check(!writePermissions(user('regional')).warehouse('w-a'),'missing assignment information fails closed');
  check(!writePermissions(user('regional'),users).createOrder('inactive'),'inactive targets cannot receive copied or new orders');
  check(!writePermissions(user('regional'),users).startInventory('w-inactive'),'inventory cannot start without an active agent');
  const inventory=(author,warehouse,createdAt,finalizedAt,status='finalized',lines=[{expected:10,counted:8},{expected:1,counted:4}])=>{
    const record={id:randomUUID(),warehouseId:warehouse,createdBy:author,createdByName:'Synthetic author',scope:'all',scopeLabel:'Synthetic inventory',createdAt,updatedAt:finalizedAt||createdAt,finalizedAt,status,revision:1,operations:[],lines:lines.map((line,i)=>({code:'SYNTHETIC-'+i,name:'Synthetic product',...line}))};
    sqlite.prepare('INSERT INTO settings VALUES(?,?)').run('inventory-v1:'+record.id,JSON.stringify(record));return record;
  };
  const created='2026-08-05T10:00:00Z';
  inventory('regional','w-a',created,'2026-08-31T21:00:00Z'); // September in Bucharest
  inventory('a','w-a',created,'2026-09-30T20:59:59.999Z');
  inventory('a-shared','w-a',created,'2026-09-15T12:00:00Z');
  inventory('inactive','w-inactive',created,'2026-09-15T12:00:00Z');
  inventory('b','w-b',created,'2026-09-15T12:00:00Z');
  inventory('regional','w-a',created,'2026-08-31T20:59:59.999Z'); // August
  inventory('a','w-a','2026-09-10T12:00:00Z','2026-09-30T21:00:00Z'); // October
  inventory('a','w-a','2026-09-01T12:00:00Z',null,'draft');
  inventory('a','w-a',created,null,'draft');
  inventory('a','w-a',created,'2026-09-01T12:00:00Z','cancelled');
  inventory('a','w-a',created,null); // no finalization event
  const totals=(value,count)=>{equal([value.finalizedInventories,value.inventoryDelta,value.inventoryShortage,value.inventorySurplus,value.inventoryDiscrepantLines],[count,count,count*2,count*3,count*2],'all finalized KPIs use one event month and one warehouse record');};
  const national=await api('manager/activity?month=2026-09');totals(national.activity.totals,5);
  const team=await api('activity/team?month=2026-09');totals(team.totals,5);
  const assigned=await activity.teamActivity(user('regional'),'2026-09');totals(assigned.totals,4);
  equal(assigned.agents.find(a=>a.agentId==='a').inventories,2,'drafts use creation month; finalized use completion month');
  equal(assigned.agents.reduce((sum,a)=>sum+a.finalizedInventories,0),3,'manager inventory is not invented agent authorship or double-counted');
  check(assigned.agents.some(a=>a.agentId==='inactive'&&!a.active),'inactive agent remains in attribution');
  totals((await api('manager/activity?month=2026-09&managerId=regional')).activity.totals,4);
  totals((await api('manager/activity?month=2026-09&agentId=a')).activity.totals,3);
  totals((await api('manager/activity?month=2026-08&agentId=a')).activity.totals,1);
  totals((await api('manager/activity?month=2026-10&agentId=a')).activity.totals,1);
  await assert.rejects(()=>activity.managerActivity(user('regional'),new URLSearchParams('month=2026-09&agentId=b')),error=>error.status===404);checks++;
  // A transferred author cannot move an inventory out of its actual warehouse.
  sqlite.prepare('UPDATE users SET warehouse_id=? WHERE id=?').run('w-b','a');
  totals((await activity.teamActivity(user('regional'),'2026-09')).totals,5);
  sqlite.prepare('DELETE FROM manager_agents WHERE manager_id=? AND agent_id=?').run('regional','a-shared');
  totals((await activity.teamActivity(user('regional'),'2026-09')).totals,2);
  sqlite.prepare('UPDATE users SET warehouse_id=? WHERE id=?').run('w-a','a');
  sqlite.prepare('INSERT INTO manager_agents VALUES(?,?)').run('regional','a-shared');
  inventory('former-agent','unassigned-warehouse',created,'2026-09-01T12:00:00Z');
  totals((await api('activity/team?month=2026-09')).totals,6);
  totals((await activity.teamActivity(user('regional'),'2026-09')).totals,4);
  // Winter UTC+2 boundary, separate from summer UTC+3 above.
  inventory('regional','w-a',created,'2025-12-31T21:59:59.999Z');
  inventory('regional','w-a',created,'2025-12-31T22:00:00Z');
  inventory('regional','w-a',created,'2026-01-31T22:00:00Z');
  totals((await api('activity/team?month=2026-01')).totals,1);

  const makeOrder=async agent=>(await api('orders','global','POST',{id:randomUUID(),kind:'combined',agentId:agent},201)).order;
  const outside=await makeOrder('b'),inside=await makeOrder('a');
  equal((await api('orders/'+outside.id)).order.id,outside.id,'national order read retained');
  await api('orders/'+outside.id,'regional','DELETE',{revision:1},404);
  await api('orders/'+outside.id,'regional','PUT',{revision:1,items:[],standItems:[],serials:[],notes:''},404);
  for(const sourceOrderId of [undefined,outside.id])await api('orders','regional','POST',{id:randomUUID(),kind:'combined',agentId:'b',sourceOrderId},404);
  await api('orders','regional','POST',{id:randomUUID(),kind:'combined',agentId:'a',sourceOrderId:inside.id},201);
  await api('orders/'+inside.id,'regional','PUT',{revision:1,items:[],standItems:[],serials:[],notes:'Synthetic update'});
  await api('inventory','regional','POST',{id:randomUUID(),warehouseId:'w-b',scope:'all'},404);
  const opened=await api('inventory','regional','POST',{id:randomUUID(),warehouseId:'w-a',scope:'all'});
  check(opened.inventory.canEdit,'assigned warehouse inventory creation works');
  const outsideInventory=inventory('b','w-b',created,null,'draft');
  const visible=await api('inventory/'+outsideInventory.id);
  check(!visible.inventory.canEdit&&!visible.inventory.canDelete,'national inventory read retains server write denial');
  await api('inventory/'+outsideInventory.id,'regional','DELETE',{revision:1},404);
  const details={};
  for(const [id,warehouseIds] of [['own',['w-a']],['outside',['w-b']],['shared',['w-b','w-a']],['inactive',['w-inactive']]]){
    const point={id,name:'Synthetic shop',warehouseId:warehouseIds[0],warehouseIds,cui:'SYNTHETIC',address:'Synthetic address',city:'Synthetic city',county:'Synthetic county',route:''};
    sqlite.prepare('INSERT INTO customers(id,warehouse_id,data) VALUES(?,?,?)').run(id,warehouseIds[0],JSON.stringify(point));
    details[id]=await api('partner/portfolio/'+id);
    equal(details[id].partner.canEdit,['own','shared'].includes(id),'partner capability uses original identity and active shared membership');
  }
  await api('partner/portfolio/outside','regional','PATCH',{...details.outside.partner,contact:'Synthetic change'},404);
  await api('partner/portfolio/own','regional','PATCH',{...details.own.partner,contact:'Synthetic change'});
  const agentShared=await api('partner/portfolio/shared','a');check(agentShared.partner.canEdit,'agent shared portfolio edit retained');
  const agentSaved=await api('partner/portfolio/shared','a','PATCH',{...agentShared.partner,contact:'Synthetic shared contact'});check(agentSaved.partner.canEdit,'successful save preserves capability');
  const followUpVisit=randomUUID();
  await api('partner/portfolio/shared/visits','a','POST',{id:followUpVisit,notes:'Synthetic visit',nextStep:'Bring the synthetic offer',followUpDate:'2026-10-02'});
  const savedFollowUp=sqlite.prepare('SELECT next_step nextStep,follow_up_date followUpDate FROM partner_visits WHERE id=?').get(followUpVisit);
  equal({...savedFollowUp},{nextStep:'Bring the synthetic offer',followUpDate:'2026-10-02'},'visit stores optional next step without changing event identity');
  equal(JSON.parse(sqlite.prepare("SELECT stops FROM partner_day_plans WHERE agent_id='a' AND plan_date='2026-10-02'").get().stops),['shared'],'follow-up reuses the existing day plan without duplicate company or agent input');
  equal((await api('partner/attention','a')).followUps.map(row=>row.customerId),['shared'],'due follow-up is actionable through current account scope');
  await api('partner/portfolio/outside/visits','b','POST',{id:randomUUID(),nextStep:'Other territory follow-up',followUpDate:'2026-10-02'});
  equal((await api('partner/attention?agentId=a','global')).followUps.map(row=>row.agentId),['a'],'manager attention respects the selected authorized agent');
  await api('partner/attention?agentId=b','regional','GET',undefined,404);
  await api('partner/portfolio/shared/visits','a','POST',{id:randomUUID(),followUpDate:'2026-10-03'},400);
  await api('partner/portfolio/outside/visits','a','POST',{id:randomUUID()},404);
  check((await api('partner/portfolio/outside','global')).partner.canEdit,'global manager can edit outside regional scope');

  // Render actual components with controlled hook state. Infrastructure-only UI
  // imports are inert; authorization props and production markup stay unchanged.
  const controlledReact=`export * from 'react';
    export function useState(initial){const queue=globalThis.__r2States;return [queue?.length?queue.shift():initial?.userId!==undefined&&globalThis.__r2Selection?globalThis.__r2Selection:typeof initial==='function'?initial():initial,()=>{}];}
    export const useEffect=()=>{};`;
  const uiPlugin={name:'controlled-components',setup(b){
    b.onResolve({filter:/^react$/},args=>args.importer.includes('/components/')||args.importer.includes('/app/')?{path:'controlled-react',namespace:'ui'}:{path:require.resolve('react'),external:true});
    b.onResolve({filter:/^react\//},args=>({path:require.resolve(args.path),external:true}));
    b.onResolve({filter:/^(?:@\/components\/|\.\/)(stock-panel|partner-map|partner-planning|partner-new)$/},args=>({path:args.path.split('/').at(-1),namespace:'ui'}));
    b.onResolve({filter:/^next\/image$/},()=>({path:'image',namespace:'ui'}));
    b.onLoad({filter:/.*/,namespace:'ui'},args=>({loader:'js',contents:args.path==='controlled-react'?controlledReact:args.path==='stock-panel'?`export const useAgentStock=()=>({lookup:new Map(),view:{importedAt:'2026-09-01',rows:[],depot:{}},loading:false,error:''});export const StockQuantity=()=>null;export const StockMetadata=()=>null;export const StockPanel=()=>null;`:args.path==='partner-new'?'export const PartnerNew=()=>null;':args.path==='partner-planning'?'export const PartnerPlanning=()=>null;':args.path==='partner-map'?'export const PartnerMap=()=>null;':'export default ()=>null;'}));
    b.onLoad({filter:/\.css$/},()=>({contents:'',loader:'js'}));
    b.onResolve({filter:/^react-dom(?:\/.*)?$/},args=>({path:require.resolve(args.path),external:true}));
  }};
  const render=(Component,props,states=[])=>{globalThis.__r2States=[...states];return renderToStaticMarkup(React.createElement(Component,props));};
  const button=(html,label)=>{const buttons=[...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)];const found=buttons.find(([,attrs,body])=>attrs.includes(label)||body.replace(/<[^>]+>/g,'').includes(label));assert.ok(found,'rendered button: '+label);return {disabled:/\bdisabled(?:=|\s|$)/.test(found[1])};};
  const {OrderTable}=await load('components/order-table.tsx',[uiPlugin]);
  for(const account of [user('regional'),user('global'),user('b')]){
    const writes=writePermissions(account,users),html=render(OrderTable,{orders:[outside],manager:account.role==='manager',onOpen:noOp,onCopy:noOp,onDelete:noOp,canWrite:order=>writes.agent(order.userId),canCopy:order=>writes.createOrder(order.userId)});
    equal(button(html,'Copiază '+outside.number).disabled,!writes.agent('b'),'order list copy permission');
    equal(button(html,'Renunță la ciornă '+outside.number).disabled,!writes.agent('b'),'order list delete permission');
    check(!button(html,'Deschide '+outside.number).disabled,'read still opens order');
  }
  const unknownList=render(OrderTable,{orders:[outside],onOpen:noOp,onCopy:noOp,onDelete:noOp});
  check(button(unknownList,'Copiază '+outside.number).disabled,'missing list capability fails closed');
  const {OrderResult}=await load('components/order-result.tsx',[uiPlugin]);
  for(const canCopy of [undefined,false,true])equal(button(render(OrderResult,{order:{...outside,status:'finalized',finalizedAt:created},onClose:noOp,onCopy:noOp,canCopy}),'Copiază pentru').disabled,canCopy!==true,'result sheet copy permission');
  for(const [file,name] of [['order-editor','OrderEditor'],['combined-order-editor','CombinedOrderEditor']]){
    const editorModule=await load('components/'+file+'.tsx',[uiPlugin]);
    for(const canEdit of [undefined,false,true]){
      const html=render(editorModule[name],{initial:{...outside,kind:file==='order-editor'?'accessories':'combined'},products:[],onClose:noOp,onSaved:noOp,onFinalized:noOp,onRecovered:noOp,canEdit});
      equal(html.includes('Salvează ciorna'),canEdit===true,'editor only mounts write controls with explicit capability');
      if(canEdit!==true){check(html.includes('doar consultare'),'draft remains readable');check(!html.includes('/excel'),'draft never offers finalized export');}
    }
  }
  const {InventoryPanel}=await load('components/inventory-panel.tsx',[uiPlugin]);
  for(const canStart of [undefined,false,true])equal(button(render(InventoryPanel,{warehouseId:'w-a',canStart}),'Pornește inventarul').disabled,canStart!==true,'inventory start capability');
  const {PartnerSheet}=await load('components/partner-portfolio.tsx',[uiPlugin]);
  for(const canEdit of [undefined,false,true]){
    const detail={...details.shared,partner:{...details.shared.partner,canEdit,latitude:45,longitude:25,positionSource:'manual',positionQuality:null,positionAccuracy:null,updatedAt:'2026-10-03T09:00:00Z'}},html=render(PartnerSheet,{id:'shared',onClose:noOp,onSaved:noOp},[detail,detail.partner]);
    equal(/<fieldset disabled=""/.test(html),canEdit!==true,'contact, GPS and pin save fieldset permission');
    equal(button(html,'Înregistrează vizita').disabled,canEdit!==true,'visit save capability');
    check(html.includes('Google Maps'),'navigation remains available');
    check(html.includes('Firma și agentul sunt completate automat'),'visit form is explicit and frictionless');
    check(html.includes('un apel, o factură sau poziția GPS nu creează o vizită'),'calls, invoices, GPS and visits remain distinct');
    check(html.includes('Pin confirmat manual'),'position provenance is visible in the selected partner');
  }
  const {PartnerAttention}=await load('components/partner-attention.tsx',[uiPlugin]);
  const attentionSales={state:'ready',month:'2026-09',source:{updatedAt:'2026-10-01T08:00:00Z',effectiveCutoff:'2026-09-30'},window:{imported:true,covered:true},counts:{new:2,repeat:1,waiting:1,overdue:1,reactivated:1}};
  const attentionHtml=render(PartnerAttention,{userId:'a',manager:false,scopeQuery:'',partners:[{...details.shared.partner,name:'Synthetic shop',latitude:45,positionSource:'geocoding',positionQuality:'locality_approximate'}],onOpen:noOp,onPlanning:noOp,onSales:noOp},[[{id:'op',userId:'a',entity:'partner/portfolio/shared',path:'partner/portfolio/shared',method:'PATCH',body:{},created:1,attempts:1,next:0,state:'blocked',error:'Synthetic conflict'}],[{visitId:'v',customerId:'shared',customerName:'Synthetic shop',agentId:'a',agentName:'Synthetic a',followUpDate:'2026-10-02',nextStep:'Bring offer'}],attentionSales,null,'']);
  check(attentionHtml.includes('Necesită atenție')&&attentionHtml.includes('Acțiuni, nu clasament'),'compact attention section is operational, not disciplinary');
  check(attentionHtml.includes('Vizibil doar pe acest dispozitiv și în contul curent'),'local queue does not claim cross-phone manager visibility');
  check(attentionHtml.includes('Confirmă prima poziție')&&attentionHtml.includes('Revenire scadentă'),'position and due follow-up have direct contextual actions');
  const appStubs={
    feedback:['Feedback'], 'product-catalog':['ProductCatalog'], 'partner-portfolio':['PartnerPortfolio'],
    'order-recovery-dialog':['OrderRecoveryDialog'], 'push-notifications':['PushNotifications'],
    admin:['Team','SettingsPanel','ManagerMailPanel'], sales:['SalesPanel'],
    'manager-workspace':['ManagerOverview','ManagerRequests','ManagerTeamLinks'],
  };
  const appPlugin={name:'app-shell-fixtures',setup(b){
    b.onResolve({filter:/^@\/components\//},args=>{
      const name=args.path.slice('@/components/'.length);
      if(name in appStubs||['ui/dialog','choice'].includes(name))return {path:name,namespace:'app-fixture'};
    });
    b.onLoad({filter:/.*/,namespace:'app-fixture'},args=>{
      let contents;
      if(args.path==='ui/dialog')contents="export const Dialog=({open,children})=>open?children:null;"+['DialogContent','DialogHeader','DialogTitle','DialogDescription'].map(name=>`export const ${name}=({children})=>children;`).join('');
      else if(args.path==='choice')contents="import {createElement as h} from 'react';export const Choice=({options,value,label,id})=>h('select',{id,'aria-label':label,value,onChange:()=>{}},options.map(option=>h('option',{key:option.value,value:option.value},option.label)));";
      else contents=appStubs[args.path].map(name=>`export const ${name}=()=>null;`).join('')+(args.path==='manager-workspace'?"export const managerCurrentMonth=()=> '2026-09';":'');
      return {loader:'js',contents};
    });
  }};
  // Real app selection and dialog code; only portal widgets and unrelated panels are inert.
  const {default:DistributionApp}=await load('app/distribution-app.tsx',[appPlugin,uiPlugin]);
  for(const [who,selectedAgent,chosenAgent,allowed] of [['regional','','b',['a','a-shared']],['regional','b','b',[]],['regional','a','a',['a']],['global','b','b',['b']]]){
    const bootstrap={user:user(who),users,orders:[outside,inside],products:[],warehouses:[]};
    globalThis.__r2Selection={userId:who,managerId:'',agentId:selectedAgent};
    const html=render(DistributionApp,{},[bootstrap,false,'',false,'portfolio',false,'stock','2026-09','orders',null,false,'combined',chosenAgent,false,'','all','all',Date.now()]);
    const select=html.match(/<select[^>]*id="order-agent"[^>]*>([\s\S]*?)<\/select>/);
    check(select,'actual create-as-agent dialog rendered');
    equal([...select[1].matchAll(/<option[^>]*value="([^"]*)"/g)].map(match=>match[1]).sort(),allowed.sort(),'creation targets intersect authenticated writes with selected read scope');
    equal(button(html,'Creează ciorna').disabled,!allowed.includes(chosenAgent),'stale or outside creation selection is disabled');
    equal(button(html,'Comandă nouă').disabled,allowed.length===0,'new-order affordance follows available writable agents');
  }
  for(const who of ['regional','global']){
    globalThis.__r2Selection={userId:who,managerId:'',agentId:''};
    const html=render(DistributionApp,{},[{user:user(who),users,orders:[outside],products:[]},false,'',false,'portfolio',false,'stock','2026-09','orders',null,false,null,'b',false,'','all','all',Date.now(),outside,false,'']);
    const confirm=html.match(/<button class="danger"([^>]*)>/);
    check(confirm,'actual delete confirmation rendered');
    equal(confirm[1].includes('disabled'),who==='regional','delete confirmation also fails closed outside write scope');
  }
  delete globalThis.__r2Selection;
  // National request consultation must not expose an outside-scope confirmation.
  const {PartnerActivityDetail}=await load('components/partner-activity-detail.tsx',[uiPlugin]);
  const request={id:'synthetic-request',company:'Synthetic request',location:'Synthetic city',county:'Synthetic county',address:'Synthetic address',cui:'991234',agentId:'b',createdAt:'2026-09-01T00:00:00Z',status:'requested',existingLocations:[],revision:1};
  const requestView={month:'2026-09',agents:[{agentId:'b',agentName:'Synthetic B',warehouseName:'Synthetic',active:true}],partnerRequests:[request],totals:{partnerRequests:1,partnerConfirmed:0}};
  const requestProps={view:requestView,month:'2026-09',loading:false,onBack:noOp,onMonthChange:noOp,onRefresh:noOp,onRequestsChanged:noOp};
  for(const account of [user('regional'),user('global'),user('region-b')]){
    const writes=writePermissions(account,users);
    const html=render(PartnerActivityDetail,{...requestProps,canConfirm:item=>writes.agent(item.agentId)});
    equal(button(html,'Confirmă').disabled,!writes.agent('b'),'confirmation action follows original assigned identity');
  }
  equal(button(render(PartnerActivityDetail,requestProps),'Confirmă').disabled,true,'unknown confirmation capability is fail-closed');
  console.log(`PASS: ${checks} focused R2 interface API, KPI, scope and rendered UI assertions.`);
} finally {
  sqlite.close();rmSync(dir,{recursive:true,force:true});delete globalThis.__r2Db;delete globalThis.__r2States;delete globalThis.__r2Selection;
}
