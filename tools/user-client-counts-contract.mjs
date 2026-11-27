// Fictional, reusable read/count contract. The caller owns both adapters,
// authority/customer DDL, native CAST oracle and independent committed writer.
import assert from 'node:assert/strict';

const NOW=1000;
const identity=id=>({userId:id,tokenHash:id+'-token'});
const ids={global:'fixture-global',regional:'fixture-regional',a:'fixture-a',b:'fixture-b',
  shared:'fixture-shared',inactive:'fixture-inactive',empty:'fixture-empty',nil:'fixture-null',
  one:'fixture-one',zero:'fixture-zero',large:'fixture-large',nested:'fixture-nested',delegated:'fixture-delegated'};
const warehouses=[{id:'warehouse-a',name:'Fictional Warehouse A'},{id:'warehouse-b',name:'Fictional Warehouse B'}];
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};

export async function runUserClientCountsContract(api,fixture){
  const {database,other,applicationSchema}=fixture,s=api.sqlIdentifier(applicationSchema),cases=[];
  const q=(kind,sqlite,postgresql=sqlite)=>api.sqlQuery(kind,sqlite,postgresql);
  const query=(tx,kind,sqlite,values=[],postgresql=sqlite)=>tx.query(q(kind,sqlite,postgresql),values);
  const write=(sqlite,values=[],postgresql=sqlite)=>database.write(tx=>query(tx,'write',sqlite,values,postgresql));
  let now=NOW;
  const repo=(db=database,seed=warehouses)=>new api.UserReadRepository(db,applicationSchema,seed,()=>now);
  const users=(who='global',db=database)=>repo(db).getUsers(identity(ids[who]));
  const counts=rows=>Object.fromEntries(rows.map(row=>[row.id,row.clientCount]));
  const addCustomer=(id,warehouse,raw,active=1)=>write(`INSERT INTO ${s}.customers(id,warehouse_id,data,active) VALUES(?,?,?,?)`,
    [id,warehouse,raw,active],`INSERT INTO ${s}.customers(id,warehouse_id,data,active) VALUES($1,$2,$3,$4)`);
  async function reset(){
    now=NOW;
    await database.write(async tx=>{
      for(const table of ['sessions','manager_agents','customers','users'])await query(tx,'write',`DELETE FROM ${s}.${table}`);
      const members=[
        {label:'global',role:'manager',scope:'global',warehouse:null,name:'Fictional Global'},
        {label:'regional',role:'manager',scope:'assigned',warehouse:null,name:'Fictional Regional'},
        {label:'a',warehouse:'warehouse-a',name:'Alpha'},
        {label:'b',warehouse:'warehouse-b',name:'Șapte'},
        {label:'shared',warehouse:'warehouse-a',name:'Zebra'},
        {label:'inactive',warehouse:'warehouse-a',name:'Inactive',active:0},
        {label:'empty',warehouse:'',name:'Empty'},
        {label:'nil',warehouse:null,name:'Null'},
        {label:'one',warehouse:'1',name:'One'},
        {label:'zero',warehouse:'0',name:'Zero'},
        {label:'large',warehouse:'9007199254740993',name:'Large'},
        {label:'nested',warehouse:'{"x":1.0}',name:'Nested'},
        {label:'delegated',warehouse:null,name:'Delegated',role:'fixture-delegated'},
      ];
      for(const item of members){
        const id=ids[item.label],values=[id,id,item.name,item.role??'agent',item.scope??'assigned',item.warehouse,
          '', 'SYNTHETIC-'+item.label,'opaque-fictional-verifier',0,item.active??1,1];
        const cols='id,username,name,role,manager_scope,warehouse_id,warehouse_name,site_code,password_hash,must_change_password,active,profile_revision';
        await query(tx,'write',`INSERT INTO ${s}.users(${cols}) VALUES(${values.map(()=>'?').join(',')})`,values,
          `INSERT INTO ${s}.users(${cols}) VALUES(${values.map((_,i)=>'$'+(i+1)).join(',')})`);
        await query(tx,'write',`INSERT INTO ${s}.sessions VALUES(?,?,?)`,[id+'-token',id,NOW+1000],`INSERT INTO ${s}.sessions VALUES($1,$2,$3)`);
      }
      for(const [manager,agent]of [['regional','b'],['regional','a'],['regional','inactive'],['delegated','a'],['delegated','b']]){
        await query(tx,'write',`INSERT INTO ${s}.manager_agents VALUES(?,?)`,[ids[manager],ids[agent]],`INSERT INTO ${s}.manager_agents VALUES($1,$2)`);
      }
      await query(tx,'write',`UPDATE ${s}.portfolio_revision SET scope_revision=100 WHERE id=1`);
    });
    for(const [id,warehouse,raw,active]of [
      ['legacy','warehouse-a','{"id":"legacy"}',1],
      ['shared','ignored','{"warehouseIds":["warehouse-a","warehouse-b","warehouse-a"]}',1],
      ['inactive','warehouse-a','{"warehouseIds":["warehouse-a","warehouse-b"]}',0],
      ['explicit-empty','warehouse-a','{"warehouseIds":[]}',1],
      ['json-null','warehouse-a','{"warehouseIds":null}',1],
      ['empty-alias','ignored','{"warehouseIds":["",""]}',1],
      ['one-alias','ignored','{"warehouseIds":[1,"1",true,1]}',1],
      ['zero-alias','ignored','{"warehouseIds":[0,-0,false,"0"]}',1],
      ['large-alias','ignored','{"warehouseIds":[9007199254740993,"9007199254740993"]}',1],
      ['nested-alias','ignored','{"warehouseIds":[ {"x":1.0}, { "x" : 1.0 }, {"x":1} ]}',1],
    ])await addCustomer(id,warehouse,raw,active);
  }
  const check=async(name,action)=>{
    try{await reset();await action();assert(!cases.includes(name));cases.push(name);}
    catch(error){error.message='User/count contract '+name+': '+error.message;throw error;}
  };
  const rejects=(action,status)=>assert.rejects(action,error=>error.status===status);
  const row=(rows,id)=>{const found=rows.find(item=>item.id===id);assert(found);return found;};

  await check('shared_duplicate_inactive_empty_null_and_numeric_alias_counts',async()=>{
    const result=counts(await users());
    assert.deepEqual(result,{[ids.global]:0,[ids.regional]:0,[ids.delegated]:0,[ids.a]:3,[ids.empty]:1,
      [ids.inactive]:3,[ids.large]:1,[ids.nested]:1,[ids.nil]:0,[ids.one]:1,[ids.shared]:3,[ids.zero]:1,[ids.b]:1});
  });
  await check('regional_manager_keeps_national_read_scope',async()=>{
    assert.deepEqual(await users('regional'),await users('global'));
  });
  await check('ordinary_agent_reads_self_only',async()=>assert.deepEqual((await users('a')).map(item=>item.id),[ids.a]));
  await check('nonmanager_assignment_fallback_is_not_national',async()=>{
    assert.deepEqual(new Set((await users('delegated')).map(item=>item.id)),new Set([ids.delegated,ids.a,ids.b]));
  });
  await check('manager_assignments_are_ordered_and_keep_inactive_members',async()=>{
    const result=await users();assert.deepEqual(row(result,ids.regional).managedAgentIds,[ids.a,ids.b,ids.inactive]);
    assert.deepEqual(row(result,ids.global).managedAgentIds,[]);assert.equal(row(result,ids.a).managedAgentIds,undefined);
  });
  await check('manager_scope_does_not_erase_stored_assignment_display',async()=>{
    await write(`INSERT INTO ${s}.manager_agents VALUES(?,?)`,[ids.global,ids.b],`INSERT INTO ${s}.manager_agents VALUES($1,$2)`);
    assert.deepEqual(row(await users(),ids.global).managedAgentIds,[ids.b]);
  });
  await check('role_desc_name_binary_order_with_diacritics',async()=>{
    const result=await users();
    const compare=(a,b)=>Buffer.compare(Buffer.from(b.role),Buffer.from(a.role))||Buffer.compare(Buffer.from(a.name),Buffer.from(b.name));
    assert.deepEqual(result.map(item=>item.id),[...result].sort(compare).map(item=>item.id));
  });
  await check('equal_role_and_name_preserve_unspecified_legacy_tie_group',async()=>{
    await write(`UPDATE ${s}.users SET name='Identical' WHERE id IN (?,?)`,[ids.a,ids.b],`UPDATE ${s}.users SET name='Identical' WHERE id IN ($1,$2)`);
    const tied=(await users()).filter(item=>item.name==='Identical');assert.deepEqual(new Set(tied.map(item=>item.id)),new Set([ids.a,ids.b]));
  });
  await check('warehouse_name_override_fallback_and_null',async()=>{
    await write(`UPDATE ${s}.users SET warehouse_name='Explicit fictional label' WHERE id=?`,[ids.b],`UPDATE ${s}.users SET warehouse_name='Explicit fictional label' WHERE id=$1`);
    const result=await users();assert.equal(row(result,ids.a).warehouseName,'Fictional Warehouse A');
    assert.equal(row(result,ids.b).warehouseName,'Explicit fictional label');assert.equal(row(result,ids.nil).warehouseName,null);
    assert.equal(row(result,ids.one).warehouseName,null);
  });
  await check('response_preserves_profile_flags_and_hides_credentials',async()=>{
    await write(`UPDATE ${s}.users SET must_change_password=1,profile_revision=7 WHERE id IN (?,?)`,[ids.regional,ids.a],
      `UPDATE ${s}.users SET must_change_password=1,profile_revision=7 WHERE id IN ($1,$2)`);
    const result=await users();assert.equal(row(result,ids.regional).mustChangePassword,true);assert.equal(row(result,ids.a).mustChangePassword,false);
    assert.equal(row(result,ids.a).profileVersion,'7');assert.equal(row(result,ids.inactive).active,0);
    for(const user of result)for(const hidden of ['password_hash','token_hash','expires_at','scope_revision'])assert(!Object.hasOwn(user,hidden));
  });
  await check('activation_pilot_uses_existing_current_role_and_active_policy',async()=>{
    const result=await users();assert.equal(row(result,ids.global).canViewActivations,true);
    assert.equal(row(result,ids.a).canViewActivations,true);assert.equal(row(result,ids.b).canViewActivations,false);
    assert.equal(row(result,ids.inactive).canViewActivations,false);
  });
  await check('count_uses_primary_customer_identity_not_payload_id',async()=>{
    await addCustomer('another-primary','warehouse-a','{"id":"legacy"}');assert.equal(row(await users(),ids.a).clientCount,4);
  });
  await check('first_duplicate_membership_key_and_nested_lexemes_remain_distinct',async()=>{
    await addCustomer('duplicate-key','ignored','{"warehouseIds":["warehouse-a"],"warehouseIds":["warehouse-b"]}');
    await addCustomer('escaped-key','ignored','{"warehouse\\u0049ds":["warehouse-b"]}');
    const result=counts(await users());assert.equal(result[ids.a],4);assert.equal(result[ids.b],2);assert.equal(result[ids.nested],1);
  });
  await check('embedded_json_membership_string_is_evaluated_twice',async()=>{
    await addCustomer('encoded','ignored',JSON.stringify({warehouseIds:'["warehouse-a",1,"1"]'}));
    const result=counts(await users());assert.equal(result[ids.a],4);assert.equal(result[ids.one],2);
  });
  await check('source_real_cast_is_explicit_refusal_and_does_not_poison_adapter',async()=>{
    await addCustomer('real-source','ignored','{"warehouseIds":[1.0]}');
    await assert.rejects(()=>users(),error=>error instanceof api.CustomerMembershipEligibilityError&&error.reason==='sqlite_real_text_cast');
    await write(`DELETE FROM ${s}.customers WHERE id='real-source'`);assert.equal(row(await users(),ids.one).clientCount,1);
  });
  await check('inactive_ineligible_source_still_requires_final_snapshot_gate',async()=>{
    const raw='{"warehouseIds":[1e0]}';await addCustomer('inactive-real','ignored',raw,0);
    assert.equal(row(await users(),ids.one).clientCount,1);
    assert.deepEqual(api.customerCountMembershipEligibility(raw,'ignored'),{eligible:false,reason:'sqlite_real_text_cast'});
  });
  for(const [label,sql,status]of [
    ['inactive',`UPDATE ${s}.users SET active=0 WHERE id='${ids.global}'`,401],
    ['expired',`UPDATE ${s}.sessions SET expires_at=${NOW} WHERE user_id='${ids.global}'`,401],
    ['logout',`DELETE FROM ${s}.sessions WHERE user_id='${ids.global}'`,401],
    ['password',`UPDATE ${s}.users SET must_change_password=1 WHERE id='${ids.global}'`,428],
  ])await check('session_gate:'+label,async()=>{await write(sql);await rejects(()=>users(),status);});
  await check('wrong_actor_rejected_with_other_valid_token',async()=>rejects(()=>repo().getUsers({userId:ids.a,tokenHash:ids.global+'-token'}),401));
  await check('manager_endpoint_guard_is_explicit',async()=>{
    await rejects(()=>repo().getUsers(identity(ids.a),true),403);assert.equal((await repo().getUsers(identity(ids.regional),true)).length,Object.keys(ids).length);
  });
  await check('agent_password_flag_keeps_legacy_read_access',async()=>{
    await write(`UPDATE ${s}.users SET must_change_password=1 WHERE id='${ids.a}'`);assert.equal((await users('a')).length,1);
  });
  await check('clock_and_session_expiry_observed_after_wait',async()=>{
    const guarded={close:async()=>{},write:()=>assert.fail(),read:fn=>{now=NOW+1000;return database.read(fn);}};
    await rejects(()=>users('global',guarded),401);
  });
  await check('single_snapshot_no_writes_and_one_active_customer_scan',async()=>{
    let reads=0,scans=0;
    const guarded={close:async()=>{},write:()=>assert.fail('Read path wrote'),read:fn=>{reads++;return database.read(tx=>fn({dialect:tx.dialect,query:(statement,values)=>{
      assert.equal(statement.kind,'read');if(statement.sqlite.includes('.customers WHERE active=1'))scans++;return tx.query(statement,values);
    }}));}};
    await users('global',guarded);assert.equal(reads,1);assert.equal(scans,1);
  });
  await check('composable_user_helper_uses_supplied_writer_transaction',async()=>{
    await database.write(async tx=>{
      await query(tx,'write',`UPDATE ${s}.customers SET active=0 WHERE id='legacy'`);
      const {user}=await api.requireSessionInTransaction(tx,s,identity(ids.global),now);
      assert.equal(row(await api.readUsersWithClientCounts(tx,s,user,warehouses),ids.a).clientCount,2);
    });
  });
  await check('composable_helper_rejects_schema_injection',async()=>{
    await database.read(async tx=>{
      const {user}=await api.requireSessionInTransaction(tx,s,identity(ids.global),now);
      for(const name of ['main','"main"; SELECT 1','"Mixed"'])await assert.rejects(()=>api.readUsersWithClientCounts(tx,name,user,warehouses),/quoted application schema/);
    });
  });
  await check('warehouse_seed_and_result_are_copied',async()=>{
    const seed=structuredClone(warehouses),instance=repo(database,seed);seed[0].name='Changed externally';
    const result=await instance.getUsers(identity(ids.global));row(result,ids.a).warehouseName='Changed result';
    assert.equal(row(await instance.getUsers(identity(ids.global)),ids.a).warehouseName,'Fictional Warehouse A');
  });

  async function interleave(match,mutation,values,who='global'){
    const trigger=deferred(),done=deferred(),stop=deferred();let fired=false,closed=false,scopeBefore,scopeAfter;
    const driver=(async()=>{await Promise.race([trigger.promise,stop.promise]);if(closed)return;
      try{if(fixture.concurrentWrite)await fixture.concurrentWrite(mutation,values);else await other.write(tx=>tx.query(mutation,values));done.resolve();}
      catch(error){done.reject(error);throw error;}})();
    const guarded={close:async()=>{},write:()=>assert.fail(),read:fn=>database.read(async tx=>{
      scopeBefore=api.safeSqlInteger((await query(tx,'read',`SELECT scope_revision FROM ${s}.portfolio_revision WHERE id=1`)).rows[0].scope_revision);
      const result=await fn({dialect:tx.dialect,query:async(statement,args)=>{
        const value=await tx.query(statement,args);if(!fired&&match(statement.sqlite)){fired=true;trigger.resolve();await done.promise;}return value;
      }});
      scopeAfter=api.safeSqlInteger((await query(tx,'read',`SELECT scope_revision FROM ${s}.portfolio_revision WHERE id=1`)).rows[0].scope_revision);return result;
    })};
    try{const result=await users(who,guarded);assert(fired);assert.equal(scopeBefore,scopeAfter);return result;}
    finally{closed=true;stop.resolve();await driver;}
  }
  const afterSession=sql=>sql.includes('.sessions s JOIN ');
  const afterUsers=sql=>sql.startsWith('SELECT u.* FROM ');
  await check('concurrent_assignment_revocation_preserves_one_portfolio_snapshot',async()=>{
    const prior=await interleave(afterSession,q('write',`DELETE FROM ${s}.manager_agents WHERE manager_id='${ids.delegated}' AND agent_id='${ids.a}'`),[],'delegated');
    assert(prior.some(item=>item.id===ids.a));assert(!(await users('delegated')).some(item=>item.id===ids.a));
  });
  await check('concurrent_role_and_warehouse_change_applies_to_next_read',async()=>{
    const prior=await interleave(afterSession,q('write',`UPDATE ${s}.users SET role='agent',warehouse_id='warehouse-a',profile_revision=profile_revision+1 WHERE id='${ids.global}'`),[]);
    assert.equal(prior.length,Object.keys(ids).length);const next=await users();assert.deepEqual(next.map(item=>item.id),[ids.global]);assert.equal(next[0].clientCount,3);
  });
  await check('concurrent_deactivation_applies_to_next_session_read',async()=>{
    assert.equal((await interleave(afterSession,q('write',`UPDATE ${s}.users SET active=0 WHERE id='${ids.global}'`),[])).length,Object.keys(ids).length);
    await rejects(()=>users(),401);
  });
  await check('concurrent_logout_applies_to_next_session_read',async()=>{
    assert.equal((await interleave(afterSession,q('write',`DELETE FROM ${s}.sessions WHERE user_id='${ids.global}'`),[])).length,Object.keys(ids).length);
    await rejects(()=>users(),401);
  });
  await check('concurrent_customer_deactivation_does_not_mix_count_snapshot',async()=>{
    const prior=await interleave(afterUsers,q('write',`UPDATE ${s}.customers SET active=0 WHERE id='legacy'`),[]);
    assert.equal(row(prior,ids.a).clientCount,3);assert.equal(row(await users(),ids.a).clientCount,2);
  });
  await check('concurrent_user_warehouse_change_does_not_mix_count_snapshot',async()=>{
    const prior=await interleave(afterUsers,q('write',`UPDATE ${s}.users SET warehouse_id='warehouse-b',profile_revision=profile_revision+1 WHERE id='${ids.a}'`),[]);
    assert.equal(row(prior,ids.a).warehouseId,'warehouse-a');assert.equal(row(prior,ids.a).clientCount,3);
    const next=row(await users(),ids.a);assert.equal(next.warehouseId,'warehouse-b');assert.equal(next.clientCount,1);
  });
  await check('concurrent_manager_assignment_display_uses_old_snapshot',async()=>{
    const prior=await interleave(afterUsers,q('write',`INSERT INTO ${s}.manager_agents VALUES(?,?)`,`INSERT INTO ${s}.manager_agents VALUES($1,$2)`),[ids.global,ids.b]);
    assert.deepEqual(row(prior,ids.global).managedAgentIds,[]);assert.deepEqual(row(await users(),ids.global).managedAgentIds,[ids.b]);
  });
  await check('concurrent_profile_update_uses_one_revision_and_label',async()=>{
    const prior=await interleave(afterSession,q('write',`UPDATE ${s}.users SET name='Changed fictional name',warehouse_name='Changed label',profile_revision=profile_revision+1 WHERE id='${ids.a}'`),[]);
    assert.equal(row(prior,ids.a).profileVersion,'1');assert.equal(row(prior,ids.a).name,'Alpha');
    const next=row(await users(),ids.a);assert.equal(next.profileVersion,'2');assert.equal(next.name,'Changed fictional name');assert.equal(next.warehouseName,'Changed label');
  });
  if(fixture.legacyOracle){
    for(const who of ['global','regional','a','b','delegated'])await check('original_getUsers_oracle:'+who,async()=>{
      assert.deepEqual(await users(who),await fixture.legacyOracle(ids[who],warehouses));
    });
    await check('original_getUsers_oracle:changed_flags_names_and_aliases',async()=>{
      await write(`UPDATE ${s}.users SET warehouse_name='Custom fictional label',profile_revision=12,must_change_password=1 WHERE id IN (?,?)`,
        [ids.regional,ids.a],`UPDATE ${s}.users SET warehouse_name='Custom fictional label',profile_revision=12,must_change_password=1 WHERE id IN ($1,$2)`);
      await addCustomer('another-primary','warehouse-a','{"id":"legacy"}');
      assert.deepEqual(await users(),await fixture.legacyOracle(ids.global,warehouses));
    });
  }
  return cases;
}

/** Exact native CAST witnesses are separate from any unsupported REAL values. */
export function runCustomerCountCastOracle(api,native){
  const cases=[];
  const supported=[['empty-string','""'],['text','"fixture-a"'],['escaped-nul',String.raw`"\u0000x"`],
    ['valid-unicode-pair',String.raw`"\ud800\udc00"`],['integer','1'],['negative-zero','-0'],['true','true'],['false','false'],['null','null'],
    ['unsafe-js-integer','9007199254740993'],['int64-max','9223372036854775807'],['int64-min','-9223372036854775808'],
    ['nested-number-lexemes',' {"x":1.0,"y":1e0} '],['nested-duplicate-keys','{"x":1,"x":2}'],
    ['nested-escaped-keys',String.raw`{"\u0061":"\u0062"}`],['nested-surrogate-lexemes',String.raw`{"\ud800":"\udc00"}`],['nested-array','[1e0,1.0]']];
  for(const [label,token]of supported)for(const [shape,value]of [['array','['+token+']'],['object','{"member":'+token+'}']]){
    const raw='{"warehouseIds":'+value+'}';
    assert.deepEqual(api.customerWarehouseCountKeys(raw,'fallback'),native(raw,'fallback'),label+':'+shape);
    assert.deepEqual(api.customerCountMembershipEligibility(raw,'fallback'),{eligible:true,reason:null});
    cases.push('native_cast_text:'+label+':'+shape);
  }
  for(const [label,raw,fallback]of [
    ['missing','{}','fallback'],['null-fallback','{"warehouseIds":null}','fallback'],['empty-fallback','{}',''],['sql-null-fallback','{}',null],
    ['empty-array','{"warehouseIds":[]}','fallback'],['duplicate-first','{"warehouseIds":["a"],"warehouseIds":["b"]}','fallback'],
    ['escaped-first',String.raw`{"warehouse\u0049ds":["a"],"warehouseIds":["b"]}`,'fallback'],
    ['scalar-int64','{"warehouseIds":9223372036854775807}','fallback'],['scalar-boolean','{"warehouseIds":true}','fallback'],
    ['encoded-document',JSON.stringify({warehouseIds:'[9007199254740993,"9007199254740993"]'}),'fallback'],
  ]){
    assert.deepEqual(api.customerWarehouseCountKeys(raw,fallback),native(raw,fallback),label);
    assert.deepEqual(api.customerCountMembershipEligibility(raw,fallback),{eligible:true,reason:null});cases.push('native_cast_text:'+label);
  }
  for(const token of ['1.0','1e0','-0.0','0.125','9223372036854775808','-9223372036854775809','1e400','-1e400'])for(const shape of ['array','scalar']){
    const raw='{"warehouseIds":'+(shape==='array'?'['+token+']':token)+'}';
    const observed=native(raw,'fallback');assert.equal(observed.length,1);assert.equal(typeof observed[0],'string');
    assert.throws(()=>api.customerWarehouseCountKeys(raw,'fallback'),error=>error instanceof api.CustomerMembershipEligibilityError&&error.reason==='sqlite_real_text_cast');
    assert.deepEqual(api.customerCountMembershipEligibility(raw,'fallback'),{eligible:false,reason:'sqlite_real_text_cast'});
    assert.equal(api.customerMembershipEligibility(raw,'fallback').eligible,true);
    cases.push('unported_real_cast_snapshot_ineligible:'+token+':'+shape);
  }
  for(const [label,raw]of [['json5',JSON.stringify({warehouseIds:"['fixture-a']"})],
    ['unicode',String.raw`{"warehouseIds":["\ud800"]}`],['invalid-json','{']]){
    assert.equal(api.customerCountMembershipEligibility(raw,'fallback').eligible,false);
    assert.throws(()=>api.customerWarehouseCountKeys(raw,'fallback'));cases.push('shared_eligibility_refusal:'+label);
  }
  return cases;
}
