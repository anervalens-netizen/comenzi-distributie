// Real application shell and notifications with isolated account authority and synthetic HTTP replies.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { browserFixture, delay, waitFor } from './offline-browser-fixture.mjs';

const source = String.raw`
import {createRoot} from 'react-dom/client';
import App from './app/distribution-app';
import {setLocalWorkUserId} from './lib/local-work';

const account = (id, name, role) => ({
  id, name, username:id, role, warehouseId:'w', warehouseName:'Synthetic warehouse',
  profileVersion:'1', managerScope:role==='manager'?'global':'assigned', mustChangePassword:false, active:1,
});
const agent = account('synthetic-agent','Synthetic agent','agent');
const manager = account('synthetic-manager','Synthetic manager','manager');
const firstLeave = '10000000-0000-0000-0000-000000000001';
const partnerId = '20000000-0000-0000-0000-000000000001';
const item = (id,title,category,targetId,readAt=null) => ({
  id,title,category,targetId,targetType:category,readAt,body:'Synthetic fixture',
  createdAt:'2026-11-10T11:00:00.000Z',
});
const items = {
  [agent.id]: [
    item('agent-first','Synthetic approved leave','leave',firstLeave),
    item('agent-second','Synthetic pending leave','leave','10000000-0000-0000-0000-000000000002'),
    ...Array.from({length:31},(_,i)=>item('agent-history-'+i,'Synthetic leave history '+i,'leave','history-'+i,'2026-11-11T11:00:00.000Z')),
  ],
  [manager.id]: [item('partner:'+partnerId,'Synthetic legacy partner','partner',partnerId)],
};
const fixture = window.fixture = {
  user:location.search.includes('manager')?manager:agent, requests:[], hold:false, pending:[],
  badBell:location.search.includes('manager')?null:{}, badCenter:location.search.includes('manager')?null:{}, badRead:null,
  switchToManager() {
    this.user=manager;
    setLocalWorkUserId(manager.id);
    window.dispatchEvent(new StorageEvent('storage',{key:'mobiup-work-user-v1'}));
  },
};
const leave = {
  id:firstLeave,agentId:agent.id,approverId:manager.id,startDate:'2026-12-01',endDate:'2026-12-02',days:2,
  status:'approved',snapshot:{legalName:'Synthetic leave applicant',employer:'Synthetic employer',approverName:'Synthetic manager',
    approverEmail:'example@example.invalid',to:'Synthetic recipient',workingDates:['2026-12-01','2026-12-02'],
    excludedDates:[],calendar:'orthodox',profileRevision:1},signedAt:'2026-11-10T11:00:00.000Z',
  submittedAt:'2026-11-10T11:00:00.000Z',decisionNote:'',createdAt:'2026-11-10T11:00:00.000Z',
  updatedAt:'2026-11-10T11:00:00.000Z',revision:2,canDecide:false,
};
const json = value => Response.json(value,{headers:{'Cache-Control':'no-store'}});
function feed(owner, category, unreadOnly, limit, offset) {
  const rows=items[owner]||[];
  const inCategory=rows.filter(row=>category==='all'||row.category===category);
  const matches=unreadOnly?inCategory.filter(row=>!row.readAt):inCategory;
  return {items:matches.slice(offset,offset+limit),unread:rows.filter(row=>!row.readAt).length,
    categoryUnread:inCategory.filter(row=>!row.readAt).length,total:matches.length,hasMore:offset+limit<matches.length};
}
window.fetch = async (input,init={}) => {
  const url=new URL(String(input),location.origin);
  const path=url.pathname.replace('/api/','');
  const owner=new Headers(init.headers).get('X-Operation-User')||fixture.user.id;
  const body=init.body?JSON.parse(init.body):null;
  fixture.requests.push({path,owner,body,query:url.search});
  switch (path) {
    case 'auth/session': return json({user:fixture.user});
    case 'bootstrap': return json({user:fixture.user,users:[agent,manager],warehouses:[{id:'w',name:'Synthetic warehouse'}],orders:[],products:[],weekKey:'2026-11-16'});
    case 'orders': return json({user:fixture.user,orders:[],weekKey:'2026-11-16'});
    case 'stock': return json({warehouseId:'w',rows:[],depot:{},warehouses:[]});
    case 'notifications/feed': {
      const bad = url.searchParams.get('limit')==='5' ? fixture.badBell : fixture.badCenter;
      if (bad) return json(bad);
      if (fixture.hold&&owner===agent.id) {
        return new Promise(resolve=>fixture.pending.push(()=>resolve(json({items:[item('old-sensitive','Synthetic stale account notification','leave',firstLeave)],unread:7,categoryUnread:7,total:1,hasMore:false}))));
      }
      return json(feed(owner,url.searchParams.get('category')||'all',url.searchParams.get('unread')==='1',
        Number(url.searchParams.get('limit')||30),Number(url.searchParams.get('offset')||0)));
    }
    case 'notifications/read':
      if (fixture.badRead) return json(fixture.badRead);
      for (const row of items[owner]||[]) {
        if (!row.readAt&&(body.ids?.includes(row.id)||(body.all&&(body.category==='all'||body.category===row.category)))) {
          row.readAt='2026-11-12T11:00:00.000Z';
        }
      }
      return json(feed(owner,body.category||'all',body.unread===true,30,0));
    case 'notifications/push': return json({publicKey:'synthetic'});
    case 'leave/'+firstLeave: return json({request:leave,events:[],documents:[]});
    case 'leave': return json({items:[leave],profiles:[],total:1,hasMore:false});
    case 'leave/profiles': return json({profiles:[]});
    case 'manager/activity': return json({activity:{totals:{finalizedInventories:0},agents:[],partnerRequests:[]},confirmed:0,confirmedByAgent:{},finalizedOrders:0,finalizedNotices:0});
    case 'partner/requests': return json({requests:[]});
    case 'partner/requests/'+partnerId: return json({request:{id:partnerId,status:'confirmed',date:'2026-11-10',
      company:'Synthetic legacy partner',cui:'Synthetic',location:'Synthetic city',existingLocations:[],
      agentId:agent.id,agentName:agent.name,warehouseName:'Synthetic warehouse',createdAt:'2026-11-10T11:00:00.000Z'}});
    default: return json({});
  }
};
createRoot(document.getElementById('root')).render(<App/>);
`;
const bundle = await build({
  stdin: {contents:source, resolveDir:resolve('.'), loader:'tsx'},
  write:false, outdir:'out', bundle:true, format:'esm', platform:'browser', jsx:'automatic',
  alias:{'next/image':resolve('tools/offline-image.tsx')},
  define:{'process.env.NODE_ENV':'"production"'}, logLevel:'silent',
});
const js = bundle.outputFiles.find(file=>file.path.endsWith('.js')).text;
const css = [
  readFileSync('app/globals.css','utf8').replace(/^@import[^\n]+\n/gm,''),
  readFileSync('app/notifications.css','utf8'),
  ...bundle.outputFiles.filter(file=>file.path.endsWith('.css')).map(file=>file.text),
].join('\n');
const wordmark = readFileSync('public/mobiup-logo.webp');
const server = createServer((request,response) => {
  if (request.url === '/mobiup-logo.webp') {
    response.setHeader('Content-Type','image/webp');
    response.end(wordmark);
    return;
  }
  const script=request.url==='/fixture.js';
  response.setHeader('Content-Type',script?'text/javascript':'text/html');
  response.end(script?js:`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script src="/fixture.js" type="module"></script>`);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));

let browser;
const button = (tab,label,within='body') => tab.evaluate(`[...document.querySelectorAll(${JSON.stringify(within+' button')})].find(button=>button.textContent.trim()===${JSON.stringify(label)}).click()`);
const click = (tab,selector) => tab.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
const wait = (tab,expr,label) => waitFor(()=>tab.evaluate(expr),label);
try {
  const origin='http://127.0.0.1:'+server.address().port;
  browser=await browserFixture(origin);
  await wait(browser,"!!document.querySelector('.request-bell')",'agent shell renders despite a malformed initial bell response');
  assert.equal(await browser.evaluate(`[...document.querySelectorAll('.main-nav [role=tab]')].map(tab=>tab.textContent.trim())`).then(tabs=>tabs.includes('Notificări')),false,'Agent notifications are accessed from the header');
  assert.equal(await browser.evaluate("!!document.querySelector('.manager-ai-trigger')"),false,'Agent has no AI shortcut');
  await click(browser,'.request-bell');
  await wait(browser,"document.querySelector('.notification-center h1')?.textContent==='Notificări'",'Agent bell opens full notifications directly');
  assert.equal(await browser.evaluate("!!document.querySelector('.notification-dialog')"),false,'No intermediate preview');
  await wait(browser,"document.activeElement?.id==='notification-heading'",'Opening the center moves keyboard focus to its title');
  await wait(browser,"document.querySelector('.notification-center [role=alert]')?.textContent.includes('format invalid')",'Notification center shows a recoverable error for a malformed feed');
  await browser.evaluate("fixture.badBell=null;fixture.badCenter=null;window.dispatchEvent(new Event('focus'))");
  await button(browser,'Reîncarcă','.notification-center .notification-panel');
  await wait(browser,"document.querySelector('.request-bell')?.getAttribute('aria-label')==='Notificări necitite 2'",'Agent badge recovers after a valid reply');
  await wait(browser,"document.querySelector('.notification-list strong')?.textContent==='Synthetic approved leave'",'Leave history appears in the full center');
  await browser.evaluate("fixture.badBell={items:[null],unread:99,categoryUnread:99,total:1,hasMore:false};fixture.badRefreshAfter=fixture.requests.length;window.dispatchEvent(new Event('focus'))");
  await wait(browser,"fixture.requests.slice(fixture.badRefreshAfter).some(request=>request.query==='?limit=5')",'Malformed badge refresh occurs');
  assert.equal(await browser.evaluate("document.querySelector('.request-count')?.textContent"),'2','Bad refresh keeps the last valid badge');
  assert.equal(await browser.evaluate("document.querySelector('.notification-list strong')?.textContent"),'Synthetic approved leave','Bad badge refresh leaves the full list alone');
  await browser.evaluate("fixture.badBell=null;fixture.badRead={items:'invalid',unread:0,categoryUnread:0,total:1,hasMore:false}");
  await click(browser,'button[aria-label="Marchează ca citită: Synthetic approved leave"]');
  await wait(browser,"document.querySelector('.notification-center [role=alert]')?.textContent.includes('format invalid')",'Bad mark-read response is handled in the full center');
  assert.equal(await browser.evaluate("document.querySelector('.request-count')?.textContent"),'2','Bad mark-read reply keeps the previous count');
  await browser.evaluate("fixture.badRead=null");
  await click(browser,'button[aria-label="Marchează ca citită: Synthetic approved leave"]');
  await wait(browser,"document.querySelector('.request-count')?.textContent==='1'",'Marking a row read updates the agent badge');
  await wait(browser,"document.querySelector('.notification-center .notification-list')?.children.length===30",'Full center displays its paginated history');
  assert.equal(await browser.evaluate("document.querySelector('.notification-center .notification-list .notification-row-unread strong')?.textContent"),'Synthetic pending leave');
  await button(browser,'Înainte','.notification-pagination');
  await wait(browser,"document.querySelector('.notification-pagination span')?.textContent==='2 / 2'",'history pagination');
  assert.equal(await browser.evaluate("document.querySelector('.notification-list').children.length"),3);
  await button(browser,'Înapoi','.notification-pagination');
  await wait(browser,"document.querySelector('.notification-pagination span')?.textContent==='1 / 2'",'return to first page');

  for (const [width,height] of [[800,1280],[1280,800],[390,844]]) {
    await browser.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:true});
    const geometry=await browser.evaluate(`(()=>{
      const range=document.querySelector('.notification-panel').getBoundingClientRect();
      return {screen:innerWidth,left:range.left,right:range.right,document:document.documentElement.scrollWidth,
        rows:[...document.querySelectorAll('.notification-row')].every(row=>row.scrollWidth<=row.clientWidth+1)};
    })()`);
    assert(geometry.left>=0&&geometry.right<=width&&geometry.screen===width&&geometry.document<=width+1&&geometry.rows,JSON.stringify({width,height,geometry}));
  }

  await button(browser,'Activări','.notification-categories');
  await wait(browser,"document.querySelector('.notification-empty')?.textContent==='Nu există notificări în această categorie.'",'inactive category shows correct empty state');
  assert.equal(await browser.evaluate("document.querySelector('.notification-panel .section-heading p')?.textContent"),'0 necitite în această categorie');
  assert.equal(await browser.evaluate("document.querySelector('.notification-filter-actions button')?.disabled"),true,'Cannot mark all in a category with no unread rows');
  assert.equal(await browser.evaluate("document.querySelector('.request-count')?.textContent"),'1','Bell still counts unread rows from other categories');
  await button(browser,'Concedii','.notification-categories');
  await wait(browser,"document.querySelectorAll('.notification-list .notification-row').length===30",'leave category with read history');
  await click(browser,'.notification-filter input');
  await wait(browser,"document.querySelector('.notification-list')?.children.length===1",'unread-only filter hides read history');
  await browser.evaluate("fixture.badRead={}");
  await button(browser,'Marchează toate ca citite','.notification-filter-actions');
  await wait(browser,"document.querySelector('.notification-center [role=alert]')?.textContent.includes('format invalid')",'bad mark-read reply is handled in the center');
  assert.equal(await browser.evaluate("document.querySelector('.notification-list strong')?.textContent"),'Synthetic pending leave','Center preserves last valid rows on invalid mutation reply');
  await browser.evaluate("fixture.badRead=null");
  await button(browser,'Marchează toate ca citite','.notification-filter-actions');
  await wait(browser,"document.querySelector('.notification-empty')?.textContent.includes('necitite')&&!document.querySelector('.request-count')",'mark all clears unread list and bell');
  await click(browser,'.notification-filter input');
  await wait(browser,"document.querySelector('.notification-list')?.firstElementChild?.querySelector('strong')?.textContent==='Synthetic approved leave'",'read notification remains in history');
  await button(browser,'Deschide','.notification-list li:first-child');
  await wait(browser,"fixture.requests.some(request=>request.path==='leave/10000000-0000-0000-0000-000000000001')",'notification opens exact leave detail');
  await wait(browser,"document.querySelector('.leave-workspace')?.textContent.includes('Aprobată')",'leave detail shown');

  await browser.evaluate("fixture.hold=true;window.dispatchEvent(new Event('focus'))");
  await wait(browser,'fixture.pending.length>0','old agent response is held before switching accounts');
  await browser.evaluate("fixture.switchToManager()");
  await wait(browser,"document.querySelector('.profile strong')?.textContent==='Synthetic manager'&&document.querySelector('.request-count')?.textContent==='1'",'manager replaces agent account');
  assert.equal(await browser.evaluate(`!!document.querySelector('.app-header button[aria-label="Agent AI"]')`),true,'Manager AI is a header action');
  const managerDestinations=await browser.evaluate(`[...document.querySelectorAll('.main-nav [role=tab]')].map(tab=>tab.textContent.trim())`);
  assert.deepEqual(managerDestinations,['Sinteză','Parteneri','Accesorii','Prepay','Focus','Echipă','Operațiuni','Concedii']);
  await wait(browser,"document.querySelector('.app-header .brand img')?.naturalWidth>0",'Real Mobiup logo loads');
  for (const width of [320,360,390]) {
    await browser.send('Emulation.setDeviceMetricsOverride',{width,height:800,deviceScaleFactor:1,mobile:true});
    const geometry=await browser.evaluate(`(()=>{
      const header=document.querySelector('.app-header');
      const brand=header.querySelector('.brand');
      const image=brand.querySelector('img');
      const mark=brand.getBoundingClientRect(), source=image.getBoundingClientRect();
      const actions=[...header.querySelectorAll('.header-right button')].map(button=>{
        const r=button.getBoundingClientRect();
        const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
        return {label:button.getAttribute('aria-label'),left:r.left,right:r.right,
          fits:r.left>=mark.right&&r.right<=innerWidth&&r.width>=44&&r.height>=44&&button.contains(hit)};
      });
      const compact=getComputedStyle(brand).overflowX==='hidden';
      const naturalCut=(mark.right-source.left)*image.naturalWidth/source.width;
      return {compact,naturalCut,markWidth:mark.width,sourceWidth:source.width,sourceHeight:source.height,actions};
    })()`);
    assert.equal(geometry.actions.length,5);
    assert(geometry.actions.every((action,i,all)=>action.fits&&(!i||action.left>=all[i-1].right)),JSON.stringify({width,geometry}));
    if (width<375) {
      // The transparent columns from 100 to 104 separate the red mark from the wordmark.
      assert(geometry.compact&&geometry.naturalCut>=100&&geometry.naturalCut<=105&&geometry.sourceHeight>=48,JSON.stringify({width,geometry}));
    } else {
      assert(!geometry.compact&&geometry.sourceWidth>=90&&geometry.markWidth>=geometry.sourceWidth-0.5,JSON.stringify({width,geometry}));
    }
  }
  await click(browser,'.request-bell');
  await wait(browser,"document.querySelector('.notification-center')?.textContent.includes('Synthetic legacy partner')",'Manager bell opens full notification history');
  await browser.evaluate("fixture.pending.splice(0).forEach(release=>release())");
  await delay(100);
  assert.equal(await browser.evaluate("document.body.textContent.includes('Synthetic stale account notification')"),false,'late old-account feed cannot overwrite new manager content');
  assert.equal(await browser.evaluate("document.querySelector('.request-count')?.textContent"),'1','old account badge is not restored');
  await button(browser,'Deschide','.notification-center');
  await wait(browser,"fixture.requests.some(request=>request.path==='partner/requests/20000000-0000-0000-0000-000000000001'&&request.owner==='synthetic-manager')",'manager opens exact legacy partner request');

  const deepLinkTab=await browser.newTab(origin+'/?notifications=1&manager=1');
  await wait(deepLinkTab,"document.querySelector('.notification-center .notification-list')?.textContent.includes('Synthetic legacy partner')",'device link opens authenticated notification center');
  const partnerLinkTab=await browser.newTab(origin+'/?request=20000000-0000-0000-0000-000000000001&manager=1');
  await wait(partnerLinkTab,"fixture.requests.some(request=>request.path==='partner/requests/20000000-0000-0000-0000-000000000001')",'Existing direct partner request links still open their matching record');
  console.log('PASS: agent and manager notification navigation, badge, read history, category, pagination, direct links, tablet layout, malformed-response recovery and late-response isolation');
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve=>server.close(resolve));
}
