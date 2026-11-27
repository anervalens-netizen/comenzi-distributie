// Fictional read contract. The caller owns the isolated authority/customer
// schema, two adapters, native legacy oracle and independent writer.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

const hash=value=>createHash('sha256').update(value).digest('hex');
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const NOW=10000;
const identity=id=>({userId:id,tokenHash:id+'-token'});
const account={global:'fictional-global',regional:'fictional-regional',a:'fictional-agent-a',b:'fictional-agent-b',
  inactive:'fictional-inactive',unassigned:'fictional-unassigned',delegated:'fictional-delegated'};
const product=(id,extra={})=>({id,code:id.toUpperCase(),name:'Fictional '+id,brand:'Synthetic',category:'Fixture',
  kind:'accessories',price:1.25,netPrice:1,sourceRow:0,image:null,...extra});
const seed={products:[product('fixture-one',{code:' code-one '}),product('fixture-two',{code:'12345670'}),
  product('fixture-empty',{ean:''})],warehouses:[{id:'fixture-a',name:'Fictional warehouse A'},
  {id:'fixture-b',name:'Fictional warehouse B'},{id:'fixture-empty',name:'Fictional empty warehouse'}]};

/** Four-column business fixture only; callers supply the real authority DDL. */
export function catalogCustomerFixtureStatements(api,applicationSchema){
  return [`CREATE TABLE ${api.sqlIdentifier(applicationSchema)}.customers(id TEXT PRIMARY KEY,warehouse_id TEXT NOT NULL,data TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1)`];
}

export async function runCatalogCustomerContract(api,fixture){
  const {database,other,applicationSchema}=fixture,s=api.sqlIdentifier(applicationSchema),cases=[];
  // Only fixture setup uses this optional control-plane adapter; repository
  // calls continue through the independently restricted application adapter.
  const setupDatabase=fixture.setupDatabase??database;
  const q=(kind,sqlite,postgresql=sqlite)=>api.sqlQuery(kind,sqlite,postgresql);
  const query=(tx,kind,sql,values=[],postgresql=sql)=>tx.query(q(kind,sql,postgresql),values);
  const write=(sql,values=[],postgresql=sql)=>setupDatabase.write(tx=>query(tx,'write',sql,values,postgresql));
  let now=NOW;
  const repo=(db=database,input=seed)=>new api.CatalogCustomerRepository(db,applicationSchema,input,()=>now);
  const catalog=(who='global',admin=false)=>repo().readCatalog(identity(account[who]),admin);
  const clients=(who='global',warehouse='fixture-a',db=database)=>repo(db).listCustomers(identity(account[who]),warehouse);
  const setting=(key,value)=>write(`INSERT INTO ${s}.settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,[key,value],
    `INSERT INTO ${s}.settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
  const putCustomer=(id,warehouse,raw,active=1)=>write(`INSERT INTO ${s}.customers VALUES(?,?,?,?)`,[id,warehouse,raw,active],
    `INSERT INTO ${s}.customers VALUES($1,$2,$3,$4)`);
  const customer=(id,extra={})=>JSON.stringify({id,name:'Fictional '+id,cui:'FIXTURE',city:'Fictional city',
    county:'Fictional county',address:'Fictional address',route:'Fixture',...extra});
  async function reset(){
    now=NOW;
    await setupDatabase.write(async tx=>{
      for(const table of ['settings','sessions','manager_agents','customers','users'])await query(tx,'write',`DELETE FROM ${s}.${table}`);
      for(const [label,id]of Object.entries(account)){
        const role=['global','regional','inactive'].includes(label)?'manager':label==='delegated'?'fixture-delegated':'agent';
        const warehouse=label==='a'?'fixture-a':label==='b'?'fixture-b':null;
        const values=[id,id,'Fictional '+label,role,label==='global'?'global':'assigned',warehouse,null,'FIXTURE-'+label,'fictional-verifier',0,label==='inactive'?0:1,1];
        const columns='id,username,name,role,manager_scope,warehouse_id,warehouse_name,site_code,password_hash,must_change_password,active,profile_revision';
        await query(tx,'write',`INSERT INTO ${s}.users(${columns}) VALUES(${values.map(()=>'?').join(',')})`,values,
          `INSERT INTO ${s}.users(${columns}) VALUES(${values.map((_,i)=>'$'+(i+1)).join(',')})`);
        await query(tx,'write',`INSERT INTO ${s}.sessions VALUES(?,?,?)`,[id+'-token',id,NOW+10000],`INSERT INTO ${s}.sessions VALUES($1,$2,$3)`);
      }
      for(const manager of ['regional','delegated'])await query(tx,'write',`INSERT INTO ${s}.manager_agents VALUES(?,?)`,
        [account[manager],account.a],`INSERT INTO ${s}.manager_agents VALUES($1,$2)`);
    });
    for(const [id,warehouse,extra,active]of [['a-legacy','fixture-a',{},1],['b-shared','fixture-a',{warehouseIds:['fixture-a','fixture-b','fixture-a']},1],
      ['c-empty','fixture-a',{warehouseIds:[]},1],['d-null','fixture-a',{warehouseIds:null},1],['e-other','fixture-b',{},1],
      ['f-inactive','fixture-a',{},0]])await putCustomer(id,warehouse,customer(id,extra),active);
  }
  const check=async(name,action)=>{try{await reset();await action();assert(!cases.includes(name));cases.push(name);}
    catch(error){error.message='Contract case '+name+': '+error.message;throw error;}};
  const rejects=(action,status,code)=>assert.rejects(action,error=>error.status===status&&(!code||error.code===code));
  const ids=rows=>rows.map(row=>row.id);

  await check('default_catalog_seed_order_and_ean_fallback',async()=>{
    const result=await catalog();assert.equal(result.raw,null);assert.equal(result.mappingsRaw,null);
    assert.deepEqual(result.products.map(row=>row.id),seed.products.map(row=>row.id));
    assert.deepEqual(result.products.map(row=>row.eans),[[],['12345670'],[]]);
    for(const row of result.products){const {version,...value}=row;assert.equal(version,hash(JSON.stringify(value)));}
  });
  await check('catalog_override_order_delete_and_new_product',async()=>{
    const raw=JSON.stringify({overrides:{'fixture-one':product('fixture-one',{name:'Changed fictional name'}),
      'fixture-two':null,'new-fictional':product('new-fictional')}});
    await setting('catalog',raw);const result=await catalog();assert.equal(result.raw,raw);
    assert.deepEqual(result.products.map(row=>row.id),['fixture-one','fixture-empty','new-fictional']);
    assert.equal(result.products[0].name,'Changed fictional name');
  });
  await check('catalog_preserves_raw_whitespace_key_order_and_mapping_bytes',async()=>{
    const raw='{ "overrides" : { } }\n',mappings='{ "96385074" : "CODE-ONE", "12345670" : "CODE-ONE" }\n';
    await setting('catalog',raw);await setting('inventory-ean-v1',mappings);const result=await catalog();
    assert.equal(result.raw,raw);assert.equal(result.mappingsRaw,mappings);assert.deepEqual(result.products[0].eans,['12345670','96385074']);
  });
  await check('explicit_ean_empty_override_and_no_duplicate_code_fallback',async()=>{
    await setting('inventory-ean-v1',JSON.stringify({'12345670':'12345670','96385074':'FIXTURE-EMPTY'}));
    await setting('catalog',JSON.stringify({overrides:{'fixture-one':product('fixture-one',{ean:'96385074'})}}));
    assert.deepEqual((await catalog()).products.map(row=>row.eans),[['96385074'],['12345670'],[]]);
  });
  await check('catalog_does_not_normalize_mapping_values_or_code_ean',async()=>{
    await setting('inventory-ean-v1',JSON.stringify({'96385074':' code-one ','12345670':'CODE-ONE'}));
    assert.deepEqual((await catalog()).products[0].eans,['12345670']);
  });
  await check('catalog_input_seed_and_result_do_not_mutate_each_other',async()=>{
    const input=structuredClone(seed),instance=repo(database,input);input.products[0].name='Changed externally';
    const result=await instance.readCatalog(identity(account.global));result.products[0].name='Changed result';
    assert.equal((await instance.readCatalog(identity(account.global))).products[0].name,seed.products[0].name);
  });
  await check('composable_catalog_helper_uses_supplied_writer_snapshot',async()=>{
    await database.write(async tx=>{
      await query(tx,'write',`INSERT INTO ${s}.settings VALUES('catalog',?)`,['{ "overrides":{} }'],`INSERT INTO ${s}.settings VALUES('catalog',$1)`);
      const result=await api.readCatalogSnapshot(tx,s,seed.products);assert.equal(result.raw,'{ "overrides":{} }');
    });
  });
  await check('catalog_helper_captures_seed_before_first_await',async()=>{
    const input=structuredClone(seed.products);
    await database.read(async tx=>{
      const result=await api.readCatalogSnapshot({dialect:tx.dialect,query:(...args)=>{
        input[0].name='Concurrent seed mutation';return tx.query(...args);
      }},s,input);assert.equal(result.products[0].name,seed.products[0].name);
    });
  });
  await check('catalog_helper_rejects_unqualified_or_injected_schema',async()=>{
    await database.read(async tx=>{for(const schema of ['main','"main".settings','"public"; SELECT 1','"Mixed"'])
      await assert.rejects(()=>api.readCatalogSnapshot(tx,schema,seed.products),/quoted application schema/);});
  });
  for(const [key,value]of [['catalog','not-json'],['catalog','{"overrides":null}'],['inventory-ean-v1','not-json']]){
    await check('malformed_catalog_is_explicit_failure:'+key+':'+value,async()=>{
      await setting(key,value);await assert.rejects(()=>catalog());
    });
  }

  const photo=Buffer.from([255,216,255,217]),photoBase64=photo.toString('base64'),filename=hash(photoBase64)+'.jpg';
  await check('photo_exact_bytes_headers_and_version_prefix',async()=>{
    await setting('catalog-photo:fictional%2Fproduct',hash(photoBase64)+':'+photoBase64);
    const result=await repo().readProductPhoto(identity(account.a),'fictional%2Fproduct',filename);
    assert.equal(result.headers.get('content-type'),'image/jpeg');assert.equal(result.headers.get('x-content-type-options'),'nosniff');
    assert.equal(result.headers.get('cache-control'),'no-store');assert.deepEqual(Buffer.from(await result.arrayBuffer()),photo);
  });
  for(const value of ['missing.jpg','a'.repeat(64)+'.png','A'.repeat(64)+'.jpg',filename+'?old=1']){
    await check('photo_filename_grammar:'+value,async()=>rejects(()=>repo().readProductPhoto(identity(account.a),'fictional',value),404));
  }
  await check('photo_key_and_old_content_hash_do_not_alias',async()=>{
    await setting('catalog-photo:fictional',hash(photoBase64)+':'+photoBase64);
    await rejects(()=>repo().readProductPhoto(identity(account.a),'other',filename),404);
    await rejects(()=>repo().readProductPhoto(identity(account.a),'fictional','0'.repeat(64)+'.jpg'),404);
  });
  await check('photo_nul_key_uses_binary_postgres_binding',async()=>{
    let observed=false;
    const guarded={close:async()=>{},write:()=>assert.fail(),read:action=>database.read(tx=>action({dialect:'postgresql',query:(statement,values=[])=>{
      if(statement.sqlite.startsWith('SELECT substr')){observed=true;assert(values[0] instanceof Uint8Array);
        assert.equal(Buffer.from(values[0]).toString('utf8'),'catalog-photo:fictional\u0000key');}
      return tx.query(statement,tx.dialect==='sqlite'?values.map(x=>x instanceof Uint8Array?Buffer.from(x).toString('utf8'):x):values);
    }}))};
    await rejects(()=>repo(guarded).readProductPhoto(identity(account.a),'fictional\u0000key',filename),404);assert(observed);
  });

  for(const [who,warehouse,expected]of [['global','fixture-a',['a-legacy','b-shared','d-null']],['regional','fixture-b',['b-shared','e-other']],
    ['a','fixture-b',['a-legacy','b-shared','d-null']],['b',null,['b-shared','e-other']],['global','unknown',[]]]){
    await check('customer_scope_and_membership:'+who+':'+warehouse,async()=>assert.deepEqual(ids(await clients(who,warehouse)),expected));
  }
  await check('only_managers_receive_raw_customer_version',async()=>{
    const raw='{"id":"lexical", "name":"Fictional name", "warehouseIds":["fixture-a"]}\n';
    await putCustomer('0-lexical','fixture-b',raw);const manager=await clients(),agent=await clients('a');
    assert.equal(manager[0].version,hash(raw));assert.equal(agent[0].version,undefined);
    assert.equal(manager[0].warehouseId,'fixture-a');assert.equal(agent[0].warehouseId,'fixture-a');
  });
  await check('customer_numeric_values_are_not_string_memberships',async()=>{
    await putCustomer('0-numeric','fixture-a',customer('0-numeric',{warehouseIds:[1,true,'2',false]}));
    assert.deepEqual(ids(await clients('global','1')),[]);assert.deepEqual(ids(await clients('global','2')),['0-numeric']);
  });
  await check('customer_duplicate_key_selects_first_membership_but_response_keeps_native_parse',async()=>{
    const raw='{"id":"duplicate-key","warehouseIds":["fixture-a"],"warehouseIds":["fixture-b"]}';
    await putCustomer('0-duplicate','fixture-b',raw);const result=await clients();
    assert.equal(result[0].id,'duplicate-key');assert.deepEqual(result[0].warehouseIds,['fixture-b']);
    assert.equal(result[0].version,hash(raw));assert(!ids(await clients('global','fixture-b')).includes('duplicate-key'));
  });
  await check('customer_nested_text_preserves_numeric_and_escaped_key_lexemes',async()=>{
    await putCustomer('0-nested','fixture-a','{"id":"nested","warehouseIds":[ { "x" : 1.0 }, { "\\u0061" : "\\u0062" } ]}');
    assert.deepEqual(ids(await clients('global','{"x":1.0}')),['nested']);assert.deepEqual(ids(await clients('global','{"x":1}')),[]);
    assert.deepEqual(ids(await clients('global','{"\\u0061":"\\u0062"}')),['nested']);
  });
  await check('customer_string_containing_json_is_parsed_twice',async()=>{
    await putCustomer('0-encoded','fixture-a',customer('encoded',{warehouseIds:'["fixture-b"]'}));
    assert.deepEqual(ids(await clients('global','fixture-b')),['encoded','b-shared','e-other']);
  });
  await check('bare_warehouse_string_is_not_silently_authorized',async()=>{
    await putCustomer('0-bad','fixture-a',customer('bad',{warehouseIds:'fixture-a'}));await assert.rejects(()=>clients());
  });
  for(const who of ['global','regional','unassigned'])await check('missing_warehouse_rejected:'+who,
    async()=>rejects(()=>clients(who,null),400,'warehouse_required'));
  await check('nonmanager_assignment_fallback_keeps_scope',async()=>{
    assert.deepEqual(ids(await clients('delegated','fixture-a')),['a-legacy','b-shared','d-null']);
    await rejects(()=>clients('delegated','fixture-b'),404,'warehouse_not_found');
  });
  for(const [who,expected]of [['global',['fixture-a','fixture-b','fixture-empty']],['regional',['fixture-a','fixture-b','fixture-empty']],
    ['a',['fixture-a']],['b',['fixture-b']],['unassigned',[]],['delegated',['fixture-a']]]){
    await check('visible_warehouses_preserve_seed_order:'+who,async()=>assert.deepEqual(ids(await repo().visibleWarehouses(identity(account[who]))),expected));
  }

  const methods=instance=>[
    ['catalog',id=>instance.readCatalog(id)],['photo',id=>instance.readProductPhoto(id,'missing',filename)],
    ['customers',id=>instance.listCustomers(id,'fixture-a')],['warehouses',id=>instance.visibleWarehouses(id)],
  ];
  for(const [label,sql,status]of [['inactive',`UPDATE ${s}.users SET active=0 WHERE id='${account.global}'`,401],
    ['expired',`UPDATE ${s}.sessions SET expires_at=${NOW} WHERE user_id='${account.global}'`,401],
    ['missing',`DELETE FROM ${s}.sessions WHERE user_id='${account.global}'`,401],
    ['password',`UPDATE ${s}.users SET must_change_password=1 WHERE id='${account.global}'`,428]]){
    for(const method of ['catalog','photo','customers','warehouses'])await check('read_authentication:'+label+':'+method,async()=>{
      await write(sql);const action=methods(repo()).find(([name])=>name===method)[1];await rejects(()=>action(identity(account.global)),status);
    });
  }
  await check('wrong_actor_with_valid_session_rejected',async()=>rejects(()=>repo().readCatalog({userId:account.a,tokenHash:account.global+'-token'}),401));
  await check('manager_only_catalog_endpoint_does_not_grant_agent_access',async()=>{
    await rejects(()=>catalog('a',true),403,'manager_required');assert.equal((await catalog('regional',true)).products.length,3);
  });
  await check('agent_password_flag_preserves_existing_read_permission',async()=>{
    await write(`UPDATE ${s}.users SET must_change_password=1 WHERE id='${account.a}'`);assert.equal((await catalog('a')).products.length,3);
  });
  await check('read_operations_each_use_one_snapshot_and_no_writes',async()=>{
    let reads=0,queries=0;
    const guarded={close:async()=>{},write:()=>assert.fail('Read operation wrote'),read:action=>{reads++;return database.read(tx=>action({dialect:tx.dialect,
      query:(statement,values)=>{assert.equal(statement.kind,'read');queries++;return tx.query(statement,values);}}));}};
    await repo(guarded).readCatalog(identity(account.global));await repo(guarded).listCustomers(identity(account.global),'fixture-a');
    await repo(guarded).visibleWarehouses(identity(account.global));assert.equal(reads,3);assert(queries>=6);
  });
  await check('clock_and_expiry_read_after_snapshot_wait',async()=>{
    const guarded={close:async()=>{},write:()=>assert.fail(),read:action=>{now=NOW+10000;return database.read(action);}};
    await rejects(()=>repo(guarded).readCatalog(identity(account.global)),401);
  });

  async function interleave(match,mutation,values,action){
    const trigger=deferred(),finished=deferred(),stop=deferred();let fired=false,closed=false;
    const driver=(async()=>{await Promise.race([trigger.promise,stop.promise]);if(closed)return;
      try{if(fixture.concurrentWrite)await fixture.concurrentWrite(mutation,values);else await other.write(tx=>tx.query(mutation,values));finished.resolve();}
      catch(error){finished.reject(error);throw error;}})();
    const guarded={close:async()=>{},write:()=>assert.fail(),read:fn=>database.read(tx=>fn({dialect:tx.dialect,query:async(statement,args)=>{
      const result=await tx.query(statement,args);if(!fired&&match(statement.sqlite)){fired=true;trigger.resolve();await finished.promise;}return result;
    }}))};
    try{const result=await action(repo(guarded));assert(fired);return result;}
    finally{closed=true;stop.resolve();await driver;}
  }
  await check('concurrent_catalog_and_mapping_commit_cannot_mix_snapshots',async()=>{
    const oldCatalog=JSON.stringify({overrides:{}}),oldMapping=JSON.stringify({'96385074':'CODE-ONE'});
    const nextCatalog=JSON.stringify({overrides:{'fixture-one':product('fixture-one',{code:'NEW-CODE'})}}),nextMapping=JSON.stringify({'12345670':'NEW-CODE'});
    await setting('catalog',oldCatalog);await setting('inventory-ean-v1',oldMapping);
    const mutation=q('write',`UPDATE ${s}.settings SET value=CASE key WHEN 'catalog' THEN ? ELSE ? END WHERE key IN ('catalog','inventory-ean-v1')`,
      `UPDATE ${s}.settings SET value=CASE key WHEN 'catalog' THEN $1 ELSE $2 END WHERE key IN ('catalog','inventory-ean-v1')`);
    const result=await interleave(sql=>sql.includes("key='catalog'"),mutation,[nextCatalog,nextMapping],instance=>instance.readCatalog(identity(account.global)));
    assert.equal(result.raw,oldCatalog);assert.equal(result.mappingsRaw,oldMapping);assert.deepEqual(result.products[0].eans,['96385074']);
    const next=await catalog();assert.equal(next.raw,nextCatalog);assert.equal(next.mappingsRaw,nextMapping);assert.deepEqual(next.products[0].eans,['12345670']);
  });
  await check('concurrent_agent_warehouse_change_applies_to_next_read',async()=>{
    const result=await interleave(sql=>sql.includes('JOIN '+s+'.users u'),q('write',`UPDATE ${s}.users SET warehouse_id='fixture-b' WHERE id='${account.a}'`),[],
      instance=>instance.listCustomers(identity(account.a),'ignored'));
    assert.deepEqual(ids(result),['a-legacy','b-shared','d-null']);assert.deepEqual(ids(await clients('a')),['b-shared','e-other']);
  });
  await check('concurrent_customer_deactivation_applies_to_next_read',async()=>{
    const result=await interleave(sql=>sql.includes('JOIN '+s+'.users u'),q('write',`UPDATE ${s}.customers SET active=0 WHERE id='a-legacy'`),[],
      instance=>instance.listCustomers(identity(account.global),'fixture-a'));
    assert.deepEqual(ids(result),['a-legacy','b-shared','d-null']);assert.deepEqual(ids(await clients()),['b-shared','d-null']);
  });
  await check('concurrent_assignment_revocation_does_not_mix_authority_snapshot',async()=>{
    const result=await interleave(sql=>sql.includes('JOIN '+s+'.users u'),q('write',`DELETE FROM ${s}.manager_agents WHERE manager_id='${account.delegated}'`),[],
      instance=>instance.listCustomers(identity(account.delegated),'fixture-a'));
    assert.equal(result.length,3);await rejects(()=>clients('delegated','fixture-a'),404);
  });
  await check('concurrent_photo_replacement_keeps_old_snapshot_and_invalidates_next_old_url',async()=>{
    await setting('catalog-photo:fictional',hash(photoBase64)+':'+photoBase64);
    const next=Buffer.from([255,216,1,255,217]).toString('base64');
    const result=await interleave(sql=>sql.includes('JOIN '+s+'.users u'),q('write',`UPDATE ${s}.settings SET value=? WHERE key='catalog-photo:fictional'`,
      `UPDATE ${s}.settings SET value=$1 WHERE key='catalog-photo:fictional'`),[hash(next)+':'+next],
      instance=>instance.readProductPhoto(identity(account.a),'fictional',filename));
    assert.deepEqual(Buffer.from(await result.arrayBuffer()),photo);await rejects(()=>repo().readProductPhoto(identity(account.a),'fictional',filename),404);
  });

  if(fixture.legacyOracle){
    for(const {label,overrides=null,mappings=null}of [{label:'default'},
      {label:'overridden',overrides:{overrides:{'fixture-two':null,'new-fictional':product('new-fictional')}}},
      {label:'mapped',overrides:{overrides:{}},mappings:{'96385074':'CODE-ONE','12345670':'CODE-ONE'}}])await check('original_catalog_oracle:'+label,async()=>{
      if(overrides)await setting('catalog',JSON.stringify(overrides));if(mappings)await setting('inventory-ean-v1',JSON.stringify(mappings));
      assert.deepEqual(await catalog(),await fixture.legacyOracle('catalog',{seed}));
    });
    for(const [who,warehouse]of [['global','fixture-a'],['regional','fixture-b'],['a','fixture-b'],['b',null],['global','unknown'],['delegated','fixture-a']]){
      await check('original_customer_oracle:'+who+':'+warehouse,async()=>{
        assert.deepEqual(await clients(who,warehouse),await fixture.legacyOracle('customers',{userId:account[who],warehouseId:warehouse,seed}));
      });
    }
    for(const who of ['global','regional','a','b','unassigned','delegated'])await check('original_warehouse_oracle:'+who,async()=>{
      assert.deepEqual(await repo().visibleWarehouses(identity(account[who])),await fixture.legacyOracle('warehouses',{userId:account[who],seed}));
    });
    await check('original_photo_oracle_preserves_bytes_and_headers',async()=>{
      await setting('catalog-photo:fictional',hash(photoBase64)+':'+photoBase64);
      const actual=await repo().readProductPhoto(identity(account.a),'fictional',filename),expected=await fixture.legacyOracle('photo',{encodedId:'fictional',filename,seed});
      assert.deepEqual([...actual.headers],[...expected.headers]);assert.deepEqual(Buffer.from(await actual.arrayBuffer()),Buffer.from(await expected.arrayBuffer()));
    });
  }
  return cases;
}

/** Native SQLite JSON1 evidence for lexical membership, kept distinct from counts. */
export function runCustomerMembershipOracle(api,native){
  const cases=[];
  const samples=[['missing','{"id":"x"}'],['null','{"warehouseIds":null}'],['empty','{"warehouseIds":[]}'],
    ['array','{"warehouseIds":["fixture-a","fixture-b","fixture-a"]}'],['object','{"warehouseIds":{"a":"fixture-a","b":"fixture-b"}}'],
    ['mixed','{"warehouseIds":[1,1.0,1e0,true,false,null,"1"]}'],['large','{"warehouseIds":[9007199254740993,9223372036854775808,1e400]}'],
    ['nested','{"warehouseIds":[ { "x" : 1.0, "y" : 1e0 }, [ "x", 2 ] ]}'],
    ['escaped','{"warehouseIds":[ { "\\u0061" : "\\u0062", "q":"\\\"\\\\" } ]}'],
    ['duplicates','{"warehouseIds":["fixture-a"],"warehouseIds":["fixture-b"]}'],
    ['escaped-property','{"warehouse\\u0049ds":["fixture-a"]}'],['empty-object','{"warehouseIds":{}}'],
    ...[true,false,1,1.0,'["fixture-a"]','{"a":"fixture-b"}','"fixture-a"','null','true','1.0'].map((value,index)=>['scalar-'+index,JSON.stringify({warehouseIds:value})]),
    ['string-root','"fixture"'],['array-root','["fixture"]'],['null-root','null'],
    ['unicode-pair',String.raw`{"warehouseIds":["\ud800\udc00"]}`],
    ['nul-member',String.raw`{"warehouseIds":["\u0000x"]}`],
    ['nested-surrogate-lexemes',String.raw`{"warehouseIds":[{"\ud800":"\udc00"}]}`],
    ['escaped-first-duplicate',String.raw`{"warehouse\u0049ds":["fixture-a"],"warehouseIds":["fixture-b"]}`]];
  for(const [label,raw]of samples){
    const expected=native(raw,'fallback').map(value=>typeof value==='bigint'?Number(value):value);
    assert.deepEqual(api.customerWarehouseValues(raw,'fallback'),expected,label);
    assert.deepEqual(api.customerMembershipEligibility(raw,'fallback'),{eligible:true,reason:null},label);
    cases.push('native_json1_membership:'+label);
  }
  for(const [label,raw]of [['invalid-json','{'],['bare-string','{"warehouseIds":"fixture-a"}'],
    ['depth','{"warehouseIds":'+'['.repeat(1001)+'1'+']'.repeat(1001)+'}']]){
    assert.throws(()=>native(raw,'fallback'),undefined,label);assert.throws(()=>api.customerWarehouseValues(raw,'fallback'),undefined,label);
    assert.equal(api.customerMembershipEligibility(raw,'fallback').eligible,false,label);
    cases.push('native_json1_rejection:'+label);
  }
  // These are measured eligibility limits, not parity cases or normalizations.
  // A migration with any such source value is blocked pending a JSON5 port.
  for(const [label,inner]of [['unicode-whitespace','\u00a0["fixture-a"]'],['trailing-comma','["fixture-a",]'],
    ['single-quotes',"['fixture-a']"],['comment','[/* fixture */"fixture-a"]']]){
    const raw=JSON.stringify({warehouseIds:inner});assert.deepEqual(native(raw,'fallback'),['fixture-a']);
    assert.throws(()=>api.customerWarehouseValues(raw,'fallback'));
    assert.deepEqual(api.customerMembershipEligibility(raw,'fallback'),{eligible:false,reason:'embedded_membership_not_strict'});
    cases.push('unported_json5_snapshot_ineligible:'+label);
  }
  for(const [label,raw]of [['high-surrogate',String.raw`{"warehouseIds":["\ud800"]}`],
    ['low-surrogate',String.raw`{"warehouseIds":["\udc00"]}`],
    ['embedded-literal-surrogate',JSON.stringify({warehouseIds:'["\ud800"]'})]]){
    const observed=native(raw,'fallback');assert.equal(observed.length,1);assert.equal(typeof observed[0],'string');
    // Native SQLite accepts the value and decodes invalid UTF-8 differently.
    // Do not replace characters or authorize against an approximate value.
    assert.notEqual(observed[0],'\ud800');assert.notEqual(observed[0],'\udc00');
    assert.throws(()=>api.customerWarehouseValues(raw,'fallback'),api.CustomerMembershipEligibilityError);
    assert.deepEqual(api.customerMembershipEligibility(raw,'fallback'),{eligible:false,reason:'decoded_membership_unicode'});
    cases.push('unported_unicode_snapshot_ineligible:'+label);
  }
  for(const [label,raw]of [['source-json5',"{warehouseIds:['fixture-a']}"],
    ['raw-lone-surrogate','{"warehouseIds":["\ud800"]}']]){
    assert.equal(api.customerMembershipEligibility(raw,'fallback').eligible,false);
    cases.push('strict_snapshot_eligibility:'+label);
  }
  return cases;
}
