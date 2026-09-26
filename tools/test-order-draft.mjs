import assert from 'node:assert/strict';
import {
  mergeConcurrentOrders,
  orderSaveBody,
  recalculateOrder,
  sameEditableOrder,
} from '../lib/order-draft.ts';

const product = (id, price=10, sourceRow=1) => ({
  id, code:id.toUpperCase(), name:id, brand:'B', category:'C', kind:'accessories',
  price, netPrice:price, sourceRow, image:null, quantity:1,
});
const order = (change={}) => ({
  id:'o1',number:'ACC-1',kind:'accessories',userId:'u1',agentName:'A',warehouseId:'w1',warehouseName:'W',
  status:'draft',items:[product('p1')],serials:[],client:null,notes:'',createdAt:'2026-09-15T00:00:00Z',finalizedAt:null,
  sourceOrderId:null,revision:1,total:10,pieces:1,...change,
});

function test(name, fn) {
  try { fn(); console.log('ok -', name); }
  catch (error) { console.error('not ok -', name); throw error; }
}

test('canonical metadata wins while a newer local quantity survives', () => {
  const base=order();
  const local=order({items:[{...product('p1'),quantity:3}]});
  const remote=order({revision:2,items:[{...product('p1',20),quantity:1}],total:20});
  const merged=mergeConcurrentOrders(base,local,remote,'local');
  assert.deepEqual(merged.conflicts,[]);
  assert.equal(merged.order.items[0].quantity,3);
  assert.equal(merged.order.items[0].price,20);
  assert.equal(merged.order.total,60);
  assert.equal(merged.order.revision,2);
});

test('independent edits are merged without conflict', () => {
  const base=order({notes:'base'});
  const local=order({notes:'mine'});
  const remote=order({revision:2,items:[{...product('p1'),quantity:2}],pieces:2,total:20,notes:'base'});
  const merged=mergeConcurrentOrders(base,local,remote,'local');
  assert.deepEqual(merged.conflicts,[]);
  assert.equal(merged.order.notes,'mine');
  assert.equal(merged.order.items[0].quantity,2);
});

test('same product quantity changed differently is a real conflict', () => {
  const base=order();
  const local=order({items:[{...product('p1'),quantity:2}]});
  const remote=order({revision:2,items:[{...product('p1',25),quantity:4}],pieces:4,total:100});
  const mine=mergeConcurrentOrders(base,local,remote,'local');
  const theirs=mergeConcurrentOrders(base,local,remote,'remote');
  assert.deepEqual(mine.conflicts,['items']);
  assert.equal(mine.order.items[0].quantity,2);
  assert.equal(mine.order.items[0].price,25);
  assert.equal(theirs.order.items[0].quantity,4);
});

test('same resulting edit is not a conflict', () => {
  const base=order();
  const local=order({notes:'same'});
  const remote=order({revision:2,notes:'same'});
  const merged=mergeConcurrentOrders(base,local,remote,'local');
  assert.deepEqual(merged.conflicts,[]);
  assert.equal(merged.order.notes,'same');
});

test('client comparison uses identity while server metadata stays canonical', () => {
  const c1={id:'c1',warehouseId:'w1',name:'Old',cui:'1',city:'X',county:'X',address:'A',route:'R'};
  const c1new={...c1,name:'Canonical'};
  const base=order({kind:'sim',items:[],serials:['123456789012345678'],client:c1,pieces:1,total:0});
  const local={...base};
  const remote={...base,revision:2,client:c1new};
  const merged=mergeConcurrentOrders(base,local,remote,'local');
  assert.deepEqual(merged.conflicts,[]);
  assert.equal(merged.order.client?.name,'Canonical');
});

test('different client selections conflict', () => {
  const c=(id)=>({id,warehouseId:'w1',name:id,cui:id,city:'X',county:'X',address:'A',route:'R'});
  const base=order({kind:'sim',items:[],serials:[],client:c('c1'),pieces:0,total:0});
  const local={...base,client:c('c2')};
  const remote={...base,revision:2,client:c('c3')};
  assert.deepEqual(mergeConcurrentOrders(base,local,remote,'local').conflicts,['client']);
  assert.equal(mergeConcurrentOrders(base,local,remote,'remote').order.client?.id,'c3');
});

test('serial edits are preserved and conflicting concurrent lists are detected', () => {
  const base=order({kind:'sim',items:[],serials:['111111111111111111'],pieces:1,total:0});
  const local={...base,serials:[...base.serials,'222222222222222222']};
  const remote={...base,revision:2,serials:[...base.serials,'333333333333333333']};
  const merged=mergeConcurrentOrders(base,local,remote,'local');
  assert.deepEqual(merged.conflicts,['serials']);
  assert.deepEqual(merged.order.serials,local.serials);
  assert.equal(merged.order.pieces,2);
});

test('combined order recalculates accessories, stand items and serials', () => {
  const combined=order({kind:'combined',items:[{...product('a',5,1),quantity:2}],standItems:[{...product('s',0,2),kind:'stands',quantity:3}],serials:['123456789012345678'],pieces:0,total:0});
  const recalculated=recalculateOrder(combined);
  assert.equal(recalculated.pieces,6);
  assert.equal(recalculated.total,10);
});

test('save payload contains only editable identifiers plus revision', () => {
  const combined=recalculateOrder(order({kind:'combined',standItems:[{...product('s',0,2),kind:'stands',quantity:2}],notes:'n'}));
  assert.deepEqual(orderSaveBody(combined,7),{
    items:[{id:'p1',quantity:1}],standItems:[{id:'s',quantity:2}],serials:[],clientId:null,notes:'n',revision:7,
  });
});

test('canonical metadata alone does not make a draft dirty', () => {
  const a=order();
  const b=order({revision:2,items:[{...product('p1',99),quantity:1}],total:99});
  assert.equal(sameEditableOrder(a,b),true);
});

console.log('10 order-draft tests passed');
