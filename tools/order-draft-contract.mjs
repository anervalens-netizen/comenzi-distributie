// Fictional, reusable application contract. The caller owns two adapters to the
// SAME isolated database, fixture DDL, account authority schema and cleanup.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
const pause=()=>new Promise(resolve=>setTimeout(resolve,20));

/** Business fixture only. Authority DDL must be supplied separately by caller. */
export function orderDraftFixtureStatements(api,applicationSchema,dialect){
  const a=api.sqlIdentifier(applicationSchema),integer=dialect==='postgresql'?'BIGINT':'INTEGER';
  const ref=table=>dialect==='sqlite'?table:a+'.'+table;
  const statements=[
    `CREATE TABLE ${a}.customers(id TEXT PRIMARY KEY,warehouse_id TEXT NOT NULL,data TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1)`,
    `CREATE TABLE ${a}.orders(id TEXT PRIMARY KEY,number TEXT NOT NULL UNIQUE,user_id TEXT NOT NULL REFERENCES ${ref('users')}(id),warehouse_id TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL,finalized_at TEXT,week_key TEXT,source_order_id TEXT,revision ${integer} NOT NULL DEFAULT 1)`,
    `CREATE TABLE ${a}.serials(serial TEXT PRIMARY KEY,order_id TEXT NOT NULL REFERENCES ${ref('orders')}(id))`,
    `CREATE TABLE ${a}.order_list_revision(id INTEGER PRIMARY KEY CHECK(id=1),revision ${integer} NOT NULL)`,
    `INSERT INTO ${a}.order_list_revision VALUES(1,1)`,
    `CREATE TABLE ${a}.order_limit_approvals(id TEXT PRIMARY KEY,order_id TEXT NOT NULL REFERENCES ${ref('orders')}(id),order_revision ${integer} NOT NULL,agent_id TEXT NOT NULL REFERENCES ${ref('users')}(id),agent_revision ${integer} NOT NULL,warehouse_id TEXT NOT NULL,manager_ids TEXT NOT NULL,input_key TEXT NOT NULL,sales_version TEXT NOT NULL,mapping_version TEXT NOT NULL,policy_version TEXT NOT NULL,catalog_version TEXT NOT NULL,violations TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','consumed')),reason TEXT NOT NULL DEFAULT '',comment TEXT NOT NULL DEFAULT '',decided_by TEXT REFERENCES ${ref('users')}(id),decided_at TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,revision ${integer} NOT NULL DEFAULT 1,UNIQUE(order_id,order_revision,input_key))`,
  ];
  if(dialect==='sqlite'){
    for(const event of ['INSERT','UPDATE','DELETE'])statements.push(`CREATE TRIGGER ${a}.order_list_revision_${event.toLowerCase()} AFTER ${event} ON orders BEGIN UPDATE order_list_revision SET revision=revision+1 WHERE id=1; END`);
  }else if(dialect==='postgresql'){
    statements.push(`CREATE FUNCTION ${a}.fixture_order_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $fixture$ BEGIN UPDATE ${a}.order_list_revision SET revision=revision+1 WHERE id=1; RETURN NULL; END $fixture$`);
    statements.push(`CREATE TRIGGER order_list_revision_change AFTER INSERT OR UPDATE OR DELETE ON ${a}.orders FOR EACH ROW EXECUTE FUNCTION ${a}.fixture_order_revision()`);
  }else throw new Error('Unsupported fixture dialect');
  return statements;
}

export async function runOrderDraftContract(api,fixture){
  const {database,other,applicationSchema}=fixture,a=api.sqlIdentifier(applicationSchema);
  const q=(kind,sqlite,postgresql=sqlite)=>api.sqlQuery(kind,sqlite,postgresql),n=api.safeSqlInteger;
  const read=(sql,values=[],postgresql=sql)=>database.read(tx=>tx.query(q('read',sql,postgresql),values));
  const write=(sql,values=[],postgresql=sql,db=database)=>db.write(tx=>tx.query(q('write',sql,postgresql),values));
  const global={userId:'fixture-global',tokenHash:'fixture-global-token'};
  const regional={userId:'fixture-regional',tokenHash:'fixture-regional-token'};
  const agent={userId:'fixture-agent-a',tokenHash:'fixture-agent-token'};
  const otherAgent={userId:'fixture-agent-b',tokenHash:'fixture-agent-b-token'};
  const ids={a:'aaaaaaaa-0000-4000-8000-000000000001',b:'bbbbbbbb-0000-4000-8000-000000000002',
    next:'cccccccc-0000-4000-8000-000000000003',four:'dddddddd-0000-4000-8000-000000000004'};
  const product=(id,kind,price,category='Fictional')=>({id,code:id.toUpperCase(),name:'Fictional '+id,
    brand:'Synthetic',category,kind,price,netPrice:price,sourceRow:0,image:null});
  const seeds={products:[product('fixture-accessory','accessories',1.25),product('fixture-second','accessories',2.1),
    product('fixture-stand','stands',null,'Standuri'),product('fixture-display','stands',9,'Display')],
    warehouses:[{id:'fixture-warehouse-a',name:'Fictional warehouse A'},{id:'fixture-warehouse-b',name:'Fictional warehouse B'}]};
  const canonical=p=>{const row={...p,ean:'',eans:[]};return{...row,version:createHash('sha256').update(JSON.stringify(row)).digest('hex')};};
  let now=1_000;
  const accounts=(db=database)=>new api.AuthorityRepository(db,applicationSchema,()=>now);
  const repo=(db=database,seed=seeds)=>new api.OrderDraftRepository(db,applicationSchema,seed,()=>now);
  const actor=(identity=regional)=>accounts().captureRequestActor(identity);
  const row=async id=>(await read(`SELECT * FROM ${a}.orders WHERE id=?`,[id],`SELECT * FROM ${a}.orders WHERE id=$1`)).rows[0];
  const listRevision=async()=>n((await read(`SELECT revision FROM ${a}.order_list_revision WHERE id=1`)).rows[0].revision);
  const snapshot=async()=>{
    const result={};
    for(const [table,order]of [['orders','id'],['serials','serial'],['order_list_revision','id'],
      ['order_limit_approvals','id'],['customers','id'],['settings','key']])result[table]=(await read(`SELECT * FROM ${a}.${table} ORDER BY ${order}`)).rows;
    return result;
  };
  const putCustomer=(id,warehouseId,memberships,active=1)=>{
    const value={id,warehouseId,name:'Fictional customer '+id,cui:'SYNTHETIC',city:'Synthetic',county:'Synthetic',
      address:'Fictional address',route:'Synthetic',...(memberships===undefined?{}:{warehouseIds:memberships})};
    return write(`INSERT INTO ${a}.customers VALUES(?,?,?,?)`,[id,warehouseId,JSON.stringify(value),active],
      `INSERT INTO ${a}.customers VALUES($1,$2,$3,$4)`);
  };
  const seedOrder=async(id=ids.a,extra={})=>{
    const payload={id,number:'ACC-19700101-'+id.slice(0,8).toUpperCase(),userId:'fixture-agent-a',agentName:'Fictional agent A',
      warehouseId:'fixture-warehouse-a',warehouseName:'Fictional warehouse A',kind:'accessories',status:'draft',items:[],
      serials:[],client:null,notes:'',createdAt:'1970-01-01T00:00:01.000Z',finalizedAt:null,sourceOrderId:null,revision:1,total:0,pieces:0,...extra};
    await write(`INSERT INTO ${a}.orders(id,number,user_id,warehouse_id,kind,status,payload,created_at,finalized_at,source_order_id,revision) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      [id,payload.number,payload.userId,payload.warehouseId,payload.kind,payload.status,JSON.stringify(payload),payload.createdAt,payload.finalizedAt,payload.sourceOrderId,payload.revision],
      `INSERT INTO ${a}.orders(id,number,user_id,warehouse_id,kind,status,payload,created_at,finalized_at,source_order_id,revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`);
    return payload;
  };
  const approval=async(id=ids.a,revision=1)=>write(`INSERT INTO ${a}.order_limit_approvals(id,order_id,order_revision,agent_id,agent_revision,warehouse_id,manager_ids,input_key,sales_version,mapping_version,policy_version,catalog_version,violations,status,created_at,updated_at) VALUES('fixture-approval',?,?,'fixture-agent-a',1,'fixture-warehouse-a','[]','fixture-input','v1','v1','v1','v1','[]','approved','fixture-time','fixture-time')`,
    [id,revision],`INSERT INTO ${a}.order_limit_approvals(id,order_id,order_revision,agent_id,agent_revision,warehouse_id,manager_ids,input_key,sales_version,mapping_version,policy_version,catalog_version,violations,status,created_at,updated_at) VALUES('fixture-approval',$1,$2,'fixture-agent-a',1,'fixture-warehouse-a','[]','fixture-input','v1','v1','v1','v1','[]','approved','fixture-time','fixture-time')`);
  const serial=async(id=ids.a,value='100000000000000000')=>write(`INSERT INTO ${a}.serials VALUES(?,?)`,[value,id],`INSERT INTO ${a}.serials VALUES($1,$2)`);
  const reset=()=>database.write(async tx=>{
    for(const table of ['order_limit_approvals','serials','orders','customers','sessions','manager_agents','login_attempts','users','settings']){
      await tx.query(q('write','DELETE FROM '+a+'.'+table));
    }
    const put=q('write',`INSERT INTO ${a}.users(id,username,name,role,manager_scope,warehouse_id,warehouse_name,site_code,password_hash,must_change_password,active,profile_revision) VALUES(?,?,?,?,?,?,NULL,?,'opaque-synthetic-fixture',0,1,1)`,
      `INSERT INTO ${a}.users(id,username,name,role,manager_scope,warehouse_id,warehouse_name,site_code,password_hash,must_change_password,active,profile_revision) VALUES($1,$2,$3,$4,$5,$6,NULL,$7,'opaque-synthetic-fixture',0,1,1)`);
    for(const [id,role,scope,warehouse,site]of [['fixture-global','manager','global',null,''],
      ['fixture-regional','manager','assigned',null,''],['fixture-agent-a','agent','assigned','fixture-warehouse-a','SITE-A'],
      ['fixture-agent-b','agent','assigned','fixture-warehouse-b','SITE-B']])await tx.query(put,[id,id,'Fictional '+id,role,scope,warehouse,site]);
    for(const identity of [global,regional,agent,otherAgent])await tx.query(q('write',
      `INSERT INTO ${a}.sessions VALUES(?,?,2000)`,`INSERT INTO ${a}.sessions VALUES($1,$2,2000)`),[identity.tokenHash,identity.userId]);
    await tx.query(q('write',`INSERT INTO ${a}.manager_agents VALUES('fixture-regional','fixture-agent-a')`));
    await tx.query(q('write',`UPDATE ${a}.portfolio_revision SET scope_revision=100 WHERE id=1`));
    await tx.query(q('write',`UPDATE ${a}.order_list_revision SET revision=1 WHERE id=1`));
  });
  const cases=[],check=async(name,action)=>{await reset();now=1000;await action();cases.push(name);};
  const status=expected=>error=>error instanceof api.AccountWriteError&&error.status===expected;
  const delegated=(db,hook,after)=>({read:action=>db.read(action),close:()=>Promise.resolve(),
    write:(action,authority)=>db.write(async tx=>{
      const proxy=hook?{dialect:tx.dialect,query:(query,values)=>hook(tx,query,values)}:tx;
      const result=await action(proxy);if(after)await after();return result;
    },authority)});
  const saveBody=(order,extra={})=>({revision:order.revision,items:order.items,standItems:order.standItems,
    serials:order.serials,clientId:order.client?.id,notes:order.notes,...extra});

  await check('read_agent_ownership_and_manager_national_visibility',async()=>{
    await seedOrder();await seedOrder(ids.b,{userId:otherAgent.userId,warehouseId:'fixture-warehouse-b'});
    assert.equal((await repo().read(regional,ids.b)).userId,otherAgent.userId);
    assert.equal((await repo().read(agent,ids.a)).userId,agent.userId);
    await assert.rejects(repo().read(agent,ids.b),status(404));
    await assert.rejects(repo().save(await actor(),ids.b,{revision:1}),status(404));
    await assert.rejects(repo().remove(await actor(),ids.b,{revision:1}),status(404));
  });
  await check('read_requires_exact_live_session_and_password_state',async()=>{
    await seedOrder();
    await assert.rejects(repo().read({...regional,userId:global.userId},ids.a),status(401));
    await write(`UPDATE ${a}.sessions SET expires_at=1000 WHERE token_hash='fixture-regional-token'`);
    await assert.rejects(repo().read(regional,ids.a),status(401));
    await write(`UPDATE ${a}.users SET must_change_password=1 WHERE id='fixture-global'`);
    await assert.rejects(repo().read(global,ids.a),status(428));
  });
  for(const [kind,prefix]of [['accessories','ACC'],['stands','STD'],['sim','SIM'],['combined','COM'],['stand_client','AVS']]){
    await check('create_'+kind+'_has_canonical_empty_shape_and_number',async()=>{
      const out=await repo().create(await actor(),{id:ids.a,kind,agentId:agent.userId});
      assert.equal(out.created,true);assert.equal(out.order.number,prefix+'-19700101-AAAAAAAA');
      assert.equal(out.order.warehouseName,'Fictional warehouse A');assert.equal(out.order.status,'draft');
      assert.equal(out.order.revision,1);assert.deepEqual(out.order.items,[]);assert.deepEqual(out.order.standItems,[]);
      assert.deepEqual(out.order.serials,[]);assert.equal(out.order.total,0);assert.equal(out.order.pieces,0);
      assert.equal(out.order.createdAt,'1970-01-01T00:00:01.000Z');assert.equal(await listRevision(),2);
    });
  }
  await check('create_agent_ignores_requested_other_agent',async()=>{
    const out=await repo().create(await actor(agent),{id:ids.a,kind:'accessories',agentId:otherAgent.userId});
    assert.equal(out.order.userId,agent.userId);assert.equal(out.order.warehouseId,'fixture-warehouse-a');
  });
  await check('create_manager_scope_and_active_target_are_required',async()=>{
    await assert.rejects(repo().create(await actor(),{id:ids.a,kind:'accessories',agentId:otherAgent.userId}),status(404));
    await write(`UPDATE ${a}.users SET active=0 WHERE id='fixture-agent-a'`);
    await assert.rejects(repo().create(await actor(),{id:ids.a,kind:'accessories',agentId:agent.userId}),status(400));
    assert.equal(await row(ids.a),undefined);
  });
  await check('create_missing_target_warehouse_refuses_without_partial_row',async()=>{
    await write(`UPDATE ${a}.users SET warehouse_id=NULL WHERE id='fixture-agent-a'`);
    await assert.rejects(repo().create(await actor(),{id:ids.a,kind:'accessories',agentId:agent.userId}),status(409));
    assert.equal(await row(ids.a),undefined);assert.equal(await listRevision(),1);
  });
  await check('create_uuid_retry_preserves_existing_authorized_order',async()=>{
    const auth=await actor(global),first=await repo().create(auth,{id:ids.a,kind:'accessories',agentId:agent.userId});
    const before=await snapshot();
    const retried=await repo().create(auth,{id:ids.a,kind:'sim',agentId:otherAgent.userId,sourceOrderId:'missing'});
    assert.equal(retried.created,false);assert.deepEqual(retried.order,first.order);assert.deepEqual(await snapshot(),before);
  });
  await check('create_number_collision_never_substitutes_other_uuid',async()=>{
    const auth=await actor();await repo().create(auth,{id:ids.a,kind:'accessories',agentId:agent.userId});
    const before=await snapshot();
    await assert.rejects(repo().create(auth,{id:'aaaaaaaa-0000-4000-8000-000000000099',kind:'accessories',agentId:agent.userId}),status(409));
    assert.deepEqual(await snapshot(),before);
  });
  await check('create_deleted_uuid_is_not_reused',async()=>{
    await seedOrder();await repo().remove(await actor(),ids.a,{revision:1});const before=await snapshot();
    await assert.rejects(repo().create(await actor(),{id:ids.a,kind:'accessories',agentId:agent.userId}),status(404));
    assert.deepEqual(await snapshot(),before);
  });
  await check('create_preserves_legacy_identifier_grammar_and_rejects_invalid_input',async()=>{
    const auth=await actor();
    for(const body of [{id:'ABCDEF00-0000-4000-8000-000000000001',kind:'sim'},
      {id:ids.a,kind:'unknown'},{id:'short',kind:'accessories'}])await assert.rejects(repo().create(auth,{...body,agentId:agent.userId}),status(400));
    assert.equal((await repo().create(auth,{id:'------------------------------------',kind:'sim',agentId:agent.userId})).created,true);
  });
  await check('copy_finalized_preserves_historical_products_and_resets_state',async()=>{
    const old={...seeds.products[0],name:'Historical synthetic name',price:7,quantity:3};
    await seedOrder(ids.a,{status:'finalized',finalizedAt:'1970-01-01T00:00:00.000Z',revision:7,items:[old],notes:'Historical note',total:21,pieces:3});
    await write(`INSERT INTO ${a}.settings VALUES('catalog',?)`,[JSON.stringify({overrides:{[old.id]:null}})],`INSERT INTO ${a}.settings VALUES('catalog',$1)`);
    const out=await repo().create(await actor(),{id:ids.next,kind:'accessories',agentId:agent.userId,sourceOrderId:ids.a});
    assert.deepEqual(out.order.items,[old]);assert.equal(out.order.total,21);assert.equal(out.order.pieces,3);
    assert.equal(out.order.status,'draft');assert.equal(out.order.revision,1);assert.equal(out.order.finalizedAt,null);
    assert.equal(out.order.sourceOrderId,ids.a);assert.equal(out.order.notes,'Historical note');
  });
  for(const kind of ['sim','combined'])await check('copy_'+kind+'_clears_sim_serials',async()=>{
    await seedOrder(ids.a,{kind,items:kind==='combined'?[{...seeds.products[0],quantity:2}]:[],
      standItems:kind==='combined'?[{...seeds.products[2],quantity:3}]:undefined,
      serials:['100000000000000000'],pieces:6,total:2.5,client:{id:'fixture-historical-client'}});
    const out=await repo().create(await actor(),{id:ids.next,kind,agentId:agent.userId,sourceOrderId:ids.a});
    assert.deepEqual(out.order.serials,[]);assert.equal(out.order.pieces,kind==='sim'?0:5);
    assert.equal(out.order.client.id,'fixture-historical-client');assert.equal(out.order.total,2.5);
  });
  await check('copy_rejects_wrong_agent_kind_scope_and_deleted_source',async()=>{
    await seedOrder();const auth=await actor(global),before=await snapshot();
    for(const body of [{kind:'sim',agentId:agent.userId},{kind:'accessories',agentId:otherAgent.userId}]){
      await assert.rejects(repo().create(auth,{id:ids.next,sourceOrderId:ids.a,...body}),status(400));
    }
    assert.deepEqual(await snapshot(),before);
    await seedOrder(ids.b,{userId:otherAgent.userId,warehouseId:'fixture-warehouse-b'});
    await assert.rejects(repo().create(await actor(),{id:ids.next,kind:'accessories',agentId:agent.userId,sourceOrderId:ids.b}),status(404));
    await repo().remove(auth,ids.a,{revision:1});
    await assert.rejects(repo().create(auth,{id:ids.next,kind:'accessories',agentId:agent.userId,sourceOrderId:ids.a}),status(404));
  });
  await check('save_uses_current_catalog_not_client_product_metadata',async()=>{
    await seedOrder();const auth=await actor(),changed=await repo().save(auth,ids.a,{revision:1,items:[{id:'fixture-accessory',quantity:3,price:999,name:'Forged'}],notes:'  note  '});
    assert.deepEqual(changed.items,[{...canonical(seeds.products[0]),quantity:3}]);
    assert.equal(changed.notes,'note');assert.equal(changed.total,3.75);assert.equal(changed.pieces,3);
    assert.equal(changed.revision,2);assert.equal(changed.itemCount,1);assert.equal(await listRevision(),3);
  });
  await check('save_catalog_overrides_removals_and_ean_version_match',async()=>{
    await seedOrder();const overridden={...seeds.products[0],price:4.5},mappings={'12345670':'FIXTURE-ACCESSORY'};
    await write(`INSERT INTO ${a}.settings VALUES('catalog',?)`,[JSON.stringify({overrides:{[overridden.id]:overridden,'fixture-second':null}})],`INSERT INTO ${a}.settings VALUES('catalog',$1)`);
    await write(`INSERT INTO ${a}.settings VALUES('inventory-ean-v1',?)`,[JSON.stringify(mappings)],`INSERT INTO ${a}.settings VALUES('inventory-ean-v1',$1)`);
    const auth=await actor(),saved=await repo().save(auth,ids.a,{revision:1,items:[{id:overridden.id,quantity:2}]});
    const product={...overridden,ean:'12345670',eans:['12345670']};
    assert.equal(saved.items[0].version,createHash('sha256').update(JSON.stringify(product)).digest('hex'));
    assert.equal(saved.total,9);assert.deepEqual(saved.items[0].eans,['12345670']);
    await assert.rejects(repo().save(auth,ids.a,{revision:2,items:[{id:'fixture-second',quantity:1}]}),status(400));
  });
  await check('save_noop_preserves_exact_row_approval_and_list_revision',async()=>{
    await seedOrder();const auth=await actor(),saved=await repo().save(auth,ids.a,{revision:1,items:[{id:'fixture-accessory',quantity:2}]});
    await approval(ids.a,2);const before=await snapshot();
    assert.deepEqual(await repo().save(auth,ids.a,saveBody(saved)),saved);assert.deepEqual(await snapshot(),before);
  });
  await check('save_empty_noop_does_not_materialize_standitems_or_increment_revision',async()=>{
    await seedOrder();await approval();const before=await snapshot();
    const saved=await repo().save(await actor(),ids.a,{revision:1});assert.equal(saved.revision,1);
    assert.deepEqual(await snapshot(),before);assert(!Object.hasOwn(JSON.parse((await row(ids.a)).payload),'standItems'));
  });
  await check('save_real_change_keeps_old_approval_bound_to_old_revision',async()=>{
    await seedOrder();await approval();const approved=(await snapshot()).order_limit_approvals;
    const result=await repo().save(await actor(),ids.a,{revision:1,notes:'changed'});
    assert.equal(result.revision,2);assert.deepEqual((await snapshot()).order_limit_approvals,approved);
    assert.equal(n(approved[0].order_revision),1);
  });
  await check('save_stale_or_non_numeric_revision_never_changes_business_state',async()=>{
    await seedOrder();const before=await snapshot(),auth=await actor();
    for(const revision of [0,2,'1',null,undefined])await assert.rejects(repo().save(auth,ids.a,{revision,notes:'late'}),status(409));
    assert.deepEqual(await snapshot(),before);
  });
  await check('save_finalized_order_is_immutable',async()=>{
    await seedOrder(ids.a,{status:'finalized'});const before=await snapshot();
    await assert.rejects(repo().save(await actor(global),ids.a,{revision:1,notes:'late'}),status(409));assert.deepEqual(await snapshot(),before);
  });
  const invalidLines=[['not_array',{}],['too_many',Array.from({length:601},()=>({id:'fixture-accessory',quantity:1}))],
    ['unknown',[{id:'missing',quantity:1}]],['duplicate',[{id:'fixture-accessory',quantity:1},{id:'fixture-accessory',quantity:2}]],
    ['wrong_kind',[{id:'fixture-stand',quantity:1}]],['zero',[{id:'fixture-accessory',quantity:0}]],
    ['fraction',[{id:'fixture-accessory',quantity:1.5}]],['string',[{id:'fixture-accessory',quantity:'1'}]],
    ['too_large',[{id:'fixture-accessory',quantity:10000}]],['invalid_item',[null]]];
  for(const [name,items]of invalidLines){
    if(typeof name!=='string')throw new Error('Invalid fixture case name');
    await check('save_rejects_'+name+'_lines_atomically',async()=>{
      await seedOrder();const before=await snapshot();await assert.rejects(repo().save(await actor(),ids.a,{revision:1,items}),status(400));
      assert.deepEqual(await snapshot(),before);
    });
  }
  await check('save_combined_preserves_line_order_and_accessory_only_total',async()=>{
    await seedOrder(ids.a,{kind:'combined',standItems:[]});
    const result=await repo().save(await actor(),ids.a,{revision:1,items:[{id:'fixture-second',quantity:1},{id:'fixture-accessory',quantity:2}],standItems:[{id:'fixture-display',quantity:3}]});
    assert.deepEqual(result.items.map(p=>p.id),['fixture-second','fixture-accessory']);assert.equal(result.total,4.6);
    assert.equal(result.pieces,6);assert.equal(result.itemCount,3);assert.equal(result.standItems[0].price,9);
  });
  await check('save_sim_normalizes_serials_and_ignores_product_input',async()=>{
    await seedOrder(ids.a,{kind:'sim'});
    const out=await repo().save(await actor(),ids.a,{revision:1,items:'ignored',serials:[' 100000000 000000000 ','200000000000000000']});
    assert.deepEqual(out.serials,['100000000000000000','200000000000000000']);assert.deepEqual(out.items,[]);
    assert.equal(out.pieces,2);assert.equal(out.total,0);
  });
  for(const [name,serials]of [['duplicate',['100000000000000000','100000000 000000000']],['number',[100]],
    ['short',['100']],['not_array','100000000000000000'],['too_many',Array(1001).fill('100000000000000000')]]){
    await check('save_serials_'+name+'_is_atomic',async()=>{await seedOrder(ids.a,{kind:'sim'});const before=await snapshot();
      await assert.rejects(repo().save(await actor(),ids.a,{revision:1,serials}),status(400));assert.deepEqual(await snapshot(),before);});
  }
  for(const [name,memberships,allowed]of [['missing',undefined,true],['null',null,true],['empty',[],false],
    ['matching',['fixture-warehouse-a'],true],['other',['fixture-warehouse-b'],false],['object',{legacy:'fixture-warehouse-a'},true],
    ['json_string','"fixture-warehouse-a"',true],['json_array_string','["fixture-warehouse-a"]',true],
    ['boolean',true,false],['number',1,false],['number_string','1',false]]){
    if(typeof name!=='string')throw new Error('Invalid fixture case name');
    await check('customer_membership_'+name+'_preserves_warehouse_scope',async()=>{
      await seedOrder(ids.a,{kind:'sim'});await putCustomer('fixture-client','fixture-warehouse-a',memberships);
      if(allowed){const saved=await repo().save(await actor(),ids.a,{revision:1,clientId:'fixture-client'});assert.equal(saved.client.warehouseId,'fixture-warehouse-a');}
      else{const before=await snapshot();await assert.rejects(repo().save(await actor(),ids.a,{revision:1,clientId:'fixture-client'}),status(400));assert.deepEqual(await snapshot(),before);}
    });
  }
  await check('customer_plain_string_is_malformed_json_not_a_membership_grant',async()=>{
    await seedOrder(ids.a,{kind:'sim'});await putCustomer('fixture-client','fixture-warehouse-a','fixture-warehouse-a');
    const before=await snapshot();await assert.rejects(repo().save(await actor(),ids.a,{revision:1,clientId:'fixture-client'}),SyntaxError);
    assert.deepEqual(await snapshot(),before);
  });
  await check('customer_multiple_memberships_override_primary_warehouse',async()=>{
    await seedOrder(ids.a,{kind:'sim'});await putCustomer('fixture-client','fixture-warehouse-b',['fixture-warehouse-a','fixture-warehouse-b']);
    assert.equal((await repo().save(await actor(),ids.a,{revision:1,clientId:'fixture-client'})).client.warehouseId,'fixture-warehouse-a');
  });
  await check('customer_inactive_and_missing_are_refused',async()=>{
    await seedOrder(ids.a,{kind:'sim'});await putCustomer('fixture-client','fixture-warehouse-a',undefined,0);const before=await snapshot();
    for(const clientId of ['fixture-client','missing'])await assert.rejects(repo().save(await actor(),ids.a,{revision:1,clientId}),status(400));
    assert.deepEqual(await snapshot(),before);
  });
  await check('stand_client_uses_only_standuri_category_and_allows_customer',async()=>{
    await seedOrder(ids.a,{kind:'stand_client'});await putCustomer('fixture-client','fixture-warehouse-a');const auth=await actor();
    const result=await repo().save(auth,ids.a,{revision:1,items:[{id:'fixture-stand',quantity:2}],clientId:'fixture-client'});
    assert.equal(result.client.id,'fixture-client');assert.equal(result.pieces,2);assert.equal(result.total,0);
    await assert.rejects(repo().save(auth,ids.a,{revision:2,items:[{id:'fixture-display',quantity:1}]}),status(400));
    await assert.rejects(repo().save(auth,ids.a,{revision:2,serials:['100000000000000000']}),status(400));
  });
  for(const kind of ['accessories','stands','combined'])await check(kind+'_draft_rejects_client_and_serials',async()=>{
    await seedOrder(ids.a,{kind,...(kind==='combined'?{standItems:[]}: {})});await putCustomer('fixture-client','fixture-warehouse-a');const auth=await actor();
    for(const body of [{clientId:'fixture-client'},{serials:['100000000000000000']}])await assert.rejects(repo().save(auth,ids.a,{revision:1,...body}),status(400));
  });
  await check('notes_trim_limit_and_unknown_payload_fields_are_preserved',async()=>{
    await seedOrder(ids.a,{extension:{fictional:true},exportKey:'fixture-object-key'});
    await repo().save(await actor(),ids.a,{revision:1,notes:' '+ 'x'.repeat(2001)+' '});
    const raw=JSON.parse((await row(ids.a)).payload);assert.equal(raw.notes.length,2000);
    assert.deepEqual(raw.extension,{fictional:true});assert.equal(raw.exportKey,'fixture-object-key');
  });
  await check('delete_cas_only_cleans_its_serials_and_retains_approval_payload',async()=>{
    await seedOrder(ids.a,{extension:{fictional:true},exportKey:'fixture-object-key'});await seedOrder(ids.b);
    await serial();await serial(ids.b,'200000000000000000');await approval();const approved=(await snapshot()).order_limit_approvals;
    const out=await repo().remove(await actor(),ids.a,{revision:1});assert.deepEqual(out,{ok:true,deletedId:ids.a,revision:2});
    const stored=await row(ids.a),payload=JSON.parse(stored.payload);assert.equal(stored.status,'deleted');
    assert.equal(payload.deletedBy,regional.userId);assert.equal(payload.deletedAt,'1970-01-01T00:00:01.000Z');
    assert.equal(payload.previousStatus,'draft');assert.equal(payload.status,'draft');assert.deepEqual(payload.extension,{fictional:true});
    assert.equal(payload.exportKey,'fixture-object-key');assert.deepEqual((await snapshot()).serials,[{serial:'200000000000000000',order_id:ids.b}]);
    assert.deepEqual((await snapshot()).order_limit_approvals,approved);assert.deepEqual((await snapshot()).settings,[]);
    await assert.rejects(repo().read(global,ids.a),status(404));
  });
  await check('delete_manager_can_remove_finalized_agent_cannot',async()=>{
    await seedOrder(ids.a,{status:'finalized'});await serial();const before=await snapshot();
    await assert.rejects(repo().remove(await actor(agent),ids.a,{revision:1}),status(403));assert.deepEqual(await snapshot(),before);
    await repo().remove(await actor(),ids.a,{revision:1});assert.equal((await row(ids.a)).status,'deleted');
  });
  await check('delete_stale_revision_keeps_serials_and_approvals',async()=>{
    await seedOrder();await serial();await approval();const before=await snapshot();
    await assert.rejects(repo().remove(await actor(),ids.a,{revision:0}),status(409));assert.deepEqual(await snapshot(),before);
  });
  await check('delete_zero_cas_count_cannot_trigger_serial_cleanup',async()=>{
    await seedOrder();await serial();const before=await snapshot();let cleanup=false;
    const db=delegated(database,async(tx,query,values)=>{
      if(query.kind==='write'&&query.sqlite.startsWith('UPDATE '+a+'.orders'))return{rows:[],changes:0};
      if(query.sqlite.startsWith('DELETE FROM '+a+'.serials'))cleanup=true;
      return tx.query(query,values);
    });
    await assert.rejects(repo(db).remove(await actor(),ids.a,{revision:1}),status(409));assert.equal(cleanup,false);assert.deepEqual(await snapshot(),before);
  });
  await check('delete_cleanup_failure_rolls_back_order_and_list_revision',async()=>{
    await seedOrder();await serial();const before=await snapshot();
    const db=delegated(database,async(tx,query,values)=>{const result=await tx.query(query,values);
      if(query.sqlite.startsWith('DELETE FROM '+a+'.serials'))throw new Error('injected-after-cleanup');return result;});
    await assert.rejects(repo(db).remove(await actor(),ids.a,{revision:1}),/injected-after-cleanup/);assert.deepEqual(await snapshot(),before);
  });
  await check('postcheck_expiry_rolls_back_order_and_serial_cleanup',async()=>{
    await seedOrder();await serial();const before=await snapshot(),db=delegated(database,null,async()=>{now=2000;});
    await assert.rejects(repo(db).remove(await actor(),ids.a,{revision:1}),status(409));assert.deepEqual(await snapshot(),before);
  });
  await check('postcheck_profile_change_inside_mutation_rolls_back_everything',async()=>{
    await seedOrder();const before=await snapshot();let injected=false;
    const db=delegated(database,async(tx,query,values)=>{const result=await tx.query(query,values);
      if(!injected&&query.sqlite.startsWith('UPDATE '+a+'.orders')){injected=true;await tx.query(q('write',`UPDATE ${a}.users SET profile_revision=profile_revision+1 WHERE id='fixture-regional'`));}
      return result;});
    await assert.rejects(repo(db).save(await actor(),ids.a,{revision:1,notes:'changed'}),status(409));
    assert.deepEqual(await snapshot(),before);assert.equal((await accounts().readAccount(regional.userId)).profileVersion,1);
  });
  await check('save_zero_cas_count_refuses_and_preserves_business_state',async()=>{
    await seedOrder();const before=await snapshot();
    const db=delegated(database,(tx,query,values)=>query.kind==='write'&&query.sqlite.startsWith('UPDATE '+a+'.orders')
      ?Promise.resolve({rows:[],changes:0}):tx.query(query,values));
    await assert.rejects(repo(db).save(await actor(),ids.a,{revision:1,notes:'changed'}),status(409));assert.deepEqual(await snapshot(),before);
  });
  await check('create_duplicate_concurrent_uuid_has_one_row_and_one_revision_tick',async()=>{
    const auth=await actor(),input={id:ids.a,kind:'accessories',agentId:agent.userId};
    const results=await Promise.all([repo().create(auth,input),repo(other).create(auth,input)]);
    assert.deepEqual(results.map(x=>x.created).sort((left,right)=>Number(left)-Number(right)),[false,true]);assert.deepEqual(results[0].order,results[1].order);
    assert.equal((await snapshot()).orders.length,1);assert.equal(await listRevision(),2);
  });
  await check('save_concurrent_revision_has_exactly_one_winner',async()=>{
    await seedOrder();const auth=await actor();
    const results=await Promise.allSettled([repo().save(auth,ids.a,{revision:1,notes:'first'}),repo(other).save(auth,ids.a,{revision:1,notes:'second'})]);
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    assert.equal(results.find(r=>r.status==='rejected').reason.status,409);assert.equal(n((await row(ids.a)).revision),2);assert.equal(await listRevision(),3);
  });
  await check('expiry_while_waiting_for_writer_lock_is_read_after_acquire',async()=>{
    await seedOrder();const auth=await actor(),before=await snapshot(),entered=deferred(),release=deferred();
    const blocker=other.write(async()=>{entered.resolve();await release.promise;});await entered.promise;
    const queued=repo().save(auth,ids.a,{revision:1,notes:'late'});const rejected=assert.rejects(queued,status(409));
    await pause();now=2000;release.resolve();await blocker;await rejected;assert.deepEqual(await snapshot(),before);
  });
  await check('caller_body_and_actor_mutation_cannot_change_queued_operation',async()=>{
    await seedOrder();const auth={...await actor()},body={revision:1,items:[{id:'fixture-accessory',quantity:2}],notes:'captured'};
    const entered=deferred(),release=deferred(),blocker=other.write(async()=>{entered.resolve();await release.promise;});await entered.promise;
    const pending=repo().save(auth,ids.a,body);body.notes='mutated';body.items[0].quantity=9;auth.userId=global.userId;auth.tokenHash=global.tokenHash;
    release.resolve();await blocker;const result=await pending;assert.equal(result.notes,'captured');assert.equal(result.items[0].quantity,2);
  });
  await check('constructor_seed_is_copied_before_caller_mutation',async()=>{
    await seedOrder();const source=structuredClone(seeds),instance=repo(database,source);source.products[0].price=999;
    const result=await instance.save(await actor(),ids.a,{revision:1,items:[{id:'fixture-accessory',quantity:2}]});assert.equal(result.total,2.5);
  });

  const revocations=[
    ['active',`UPDATE ${a}.users SET active=0 WHERE id='fixture-regional'`],
    ['logout',`DELETE FROM ${a}.sessions WHERE token_hash='fixture-regional-token'`],
    ['expiry',`UPDATE ${a}.sessions SET expires_at=1000 WHERE token_hash='fixture-regional-token'`],
    ['role',`UPDATE ${a}.users SET role='agent' WHERE id='fixture-regional'`],
    ['profile',`UPDATE ${a}.users SET profile_revision=profile_revision+1 WHERE id='fixture-regional'`],
    ['manager_scope',`UPDATE ${a}.users SET manager_scope='global' WHERE id='fixture-regional'`],
    ['password_required',`UPDATE ${a}.users SET must_change_password=1 WHERE id='fixture-regional'`],
    ['assignments',`DELETE FROM ${a}.manager_agents WHERE manager_id='fixture-regional'`],
    ['warehouse',`UPDATE ${a}.users SET warehouse_id='fixture-warehouse-b' WHERE id='fixture-agent-a'`],
  ];
  const operations={
    create:(r,auth)=>r.create(auth,{id:ids.next,kind:'accessories',agentId:agent.userId}),
    copy:(r,auth)=>r.create(auth,{id:ids.next,kind:'accessories',agentId:agent.userId,sourceOrderId:ids.a}),
    save:(r,auth)=>r.save(auth,ids.a,{revision:1,notes:'committed draft change'}),
    delete:(r,auth)=>r.remove(auth,ids.a,{revision:1}),
  };
  for(const [revocation,sql]of revocations)for(const [operation,mutate]of Object.entries(operations)){
    await check(revocation+'_commits_before_queued_'+operation+'_and_blocks_it',async()=>{
      await seedOrder();await serial();const auth=await actor(),before=await snapshot(),entered=deferred(),release=deferred();
      const revoke=other.write(async tx=>{entered.resolve();await release.promise;await tx.query(q('write',sql));});await entered.promise;
      const denied=assert.rejects(mutate(repo(),auth),status(409));await pause();release.resolve();await revoke;await denied;
      assert.deepEqual(await snapshot(),before);
    });
    await check(operation+'_commits_before_queued_'+revocation+'_without_partial_effects',async()=>{
      await seedOrder();await serial();const auth=await actor(),entered=deferred(),release=deferred();
      const controlled=delegated(database,null,async()=>{entered.resolve();await release.promise;});
      const mutation=mutate(repo(controlled),auth);await entered.promise;
      let revoked=false;const revoke=write(sql,[],sql,other).then(()=>{revoked=true;});await pause();assert.equal(revoked,false);
      release.resolve();await mutation;await revoke;
      if(operation==='create'||operation==='copy'){assert.equal((await row(ids.next)).status,'draft');assert.equal(await listRevision(),3);}
      if(operation==='save'){assert.equal(n((await row(ids.a)).revision),2);assert.equal(JSON.parse((await row(ids.a)).payload).notes,'committed draft change');}
      if(operation==='delete'){assert.equal((await row(ids.a)).status,'deleted');assert.deepEqual((await snapshot()).serials,[]);}
      await assert.rejects(repo().create(auth,{id:ids.four,kind:'accessories',agentId:agent.userId}),status(409));
    });
  }
  return cases;
}
