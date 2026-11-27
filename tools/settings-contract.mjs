// Fictional settings contract, reusable with isolated SQLite or PostgreSQL
// adapters. The caller supplies schema ownership, two connections and oracles.
import assert from 'node:assert/strict';

const NOW=10000;
const ids={global:'fixture-global',regional:'fixture-regional',second:'fixture-second',empty:'fixture-empty',
  a:'fixture-agent-a',b:'fixture-agent-b',inactive:'fixture-inactive',off:'fixture-off'};
const identity=id=>({userId:id,tokenHash:id+'-token'});
const defaults={partnerTo:['partner@example.invalid'],partnerCc:['archive@example.invalid']};
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
const appBody={weeklyLimit:3,accessoriesEmail:'accessories@example.invalid',standsEmail:'stands@example.invalid',simEmail:'sim@example.invalid'};

export async function runSettingsContract(api,fixture){
  const {database,other,applicationSchema}=fixture,s=api.sqlIdentifier(applicationSchema),cases=[];
  const q=(kind,sqlite,postgresql=sqlite)=>api.sqlQuery(kind,sqlite,postgresql);
  const query=(tx,kind,sql,values=[],postgresql=sql)=>tx.query(q(kind,sql,postgresql),values);
  const write=(sql,values=[],postgresql=sql,db=database)=>db.write(tx=>query(tx,'write',sql,values,postgresql));
  const read=(sql,values=[],postgresql=sql)=>database.read(tx=>query(tx,'read',sql,values,postgresql));
  let now=NOW;
  const repo=(db=database,input=defaults)=>new api.SettingsRepository(db,applicationSchema,input,()=>now);
  const actor=(who='global',db=database)=>new api.AuthorityRepository(db,applicationSchema,()=>now).captureRequestActor(identity(ids[who]));
  const put=(key,value)=>write(`INSERT INTO ${s}.settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,[key,value],
    `INSERT INTO ${s}.settings VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
  const settings=async()=>(await read(`SELECT key,value FROM ${s}.settings ORDER BY key`)).rows;
  const raw=async key=>(await read(`SELECT value FROM ${s}.settings WHERE key=?`,[key],`SELECT value FROM ${s}.settings WHERE key=$1`)).rows[0]?.value??null;
  const update=(input=appBody,db=database,snapshot)=>snapshot?repo(db).updateAppSettings(snapshot,input):actor().then(value=>repo(db).updateAppSettings(value,input));
  const reset=async()=>{
    now=NOW;
    await database.write(async tx=>{
      for(const table of ['settings','sessions','manager_agents','users'])await query(tx,'write',`DELETE FROM ${s}.${table}`);
      for(const [name,id]of Object.entries(ids)){
        const manager=['global','regional','second','empty','off'].includes(name);
        const values=[id,id,'Fictional '+name,manager?'manager':'agent',name==='global'?'global':'assigned',manager?null:'warehouse-'+name,
          null,manager?'':'SITE-'+name,'fictional-verifier',0,['inactive','off'].includes(name)?0:1,1];
        await query(tx,'write',`INSERT INTO ${s}.users(id,username,name,role,manager_scope,warehouse_id,warehouse_name,site_code,password_hash,must_change_password,active,profile_revision) VALUES(${values.map(()=>'?').join(',')})`,values,
          `INSERT INTO ${s}.users(id,username,name,role,manager_scope,warehouse_id,warehouse_name,site_code,password_hash,must_change_password,active,profile_revision) VALUES(${values.map((_,i)=>'$'+(i+1)).join(',')})`);
        await query(tx,'write',`INSERT INTO ${s}.sessions VALUES(?,?,?)`,[id+'-token',id,NOW+10000],`INSERT INTO ${s}.sessions VALUES($1,$2,$3)`);
      }
      for(const [manager,agent]of [['regional','b'],['regional','a'],['regional','inactive'],['second','a'],['off','a'],['global','a']]){
        await query(tx,'write',`INSERT INTO ${s}.manager_agents VALUES(?,?)`,[ids[manager],ids[agent]],`INSERT INTO ${s}.manager_agents VALUES($1,$2)`);
      }
    });
  };
  const check=async(name,action)=>{try{await reset();await action();assert(!cases.includes(name));cases.push(name);}
    catch(error){error.message='Contract case '+name+': '+error.message;throw error;}};
  const reject=(action,status,code)=>assert.rejects(action,error=>error.status===status&&(!code||error.code===code));
  const proxy=(db,{readHook,writeHook,afterWrite}={})=>({close:async()=>{},
    read:action=>db.read(tx=>action(readHook?{dialect:tx.dialect,query:(statement,values=[])=>readHook(tx,statement,values)}:tx)),
    write:(action,authority)=>db.write(async tx=>{const result=await action(writeHook?{
      dialect:tx.dialect,query:(statement,values=[])=>writeHook(tx,statement,values)}:tx);if(afterWrite)await afterWrite(tx);return result;},authority)});
  // SQLite-only proxy decodes the binary binding for its native statement.
  // A real PostgreSQL transaction must retain the exact BYTEA parameter.
  const pgParameterReader=(tx,seen)=>({dialect:'postgresql',query:(statement,values=[])=>{
    assert(values.every(value=>typeof value!=='string'||!value.includes('\u0000')),'PostgreSQL TEXT parameter contains NUL');
    const binary=values.some(value=>value instanceof Uint8Array);
    if(binary){
      assert.equal(values.length,1);assert(values[0] instanceof Uint8Array);
      assert.match(statement.postgresql,/convert_to\((?:key|ma\.(?:manager_id|agent_id)),'UTF8'\)=\$1::bytea/);
    }
    seen.push({sql:statement.postgresql,binary});
    return tx.query(statement,tx.dialect==='sqlite'
      ?values.map(value=>value instanceof Uint8Array?new TextDecoder('utf8',{fatal:true}).decode(value):value):values);
  }});
  async function oracle(kind,method,args,who,action){
    if(!fixture.legacyOracle)throw new Error('Original settings oracle is required');
    const expected=await fixture.legacyOracle({kind,method,args,viewerId:ids[who],defaults});
    if(expected.ok){assert.deepEqual(await action(),expected.result);}
    else await assert.rejects(action,error=>expected.status!==null?error.status===expected.status:error.name===expected.errorName);
    assert.deepEqual(await settings(),expected.settings);
  }

  await check('default_settings_raw_absence_and_unlimited',async()=>oracle('read','readAppSettings',[],'a',
    ()=>repo().readAppSettings(identity(ids.a))));
  for(const value of [0,1,7,2147483647,-1,8,1.5,'0','3',null,true,{},[]])await check('weekly_limit_read:'+JSON.stringify(value),async()=>{
    await put('app',JSON.stringify({weeklyLimit:value,unknown:{kept:true}}));
    await oracle('read','readAppSettings',[],'global',()=>repo().readAppSettings(identity(ids.global)));
  });
  await check('unknown_props_raw_bytes_and_missing_limit_preserved',async()=>{
    const value='{ "unknown" : { "x" : 1 }, "accessoriesEmail":"legacy@example.invalid" }\n';await put('app',value);
    await oracle('read','readAppSettings',[],'a',()=>repo().readAppSettings(identity(ids.a)));
    assert.equal((await repo().readAppSettings(identity(ids.a))).raw,value);
  });
  await check('duplicate_setting_json_keys_keep_original_parse_semantics',async()=>{
    await put('app','{"weeklyLimit":1,"weeklyLimit":7,"unknown":0}');
    await oracle('read','readAppSettings',[],'global',()=>repo().readAppSettings(identity(ids.global)));
  });
  for(const value of ['{','null','1','true','"text"','[]'])await check('stored_app_shape:'+value,async()=>{
    await put('app',value);await oracle('read','readAppSettings',[],'a',()=>repo().readAppSettings(identity(ids.a)));
  });
  await check('defaults_and_result_are_independent_copies',async()=>{
    const input=structuredClone(defaults),instance=repo(database,input);input.partnerTo[0]='changed@example.invalid';
    const first=await instance.settings(identity(ids.a));assert.deepEqual(first.partnerTo,defaults.partnerTo);first.partnerTo.length=0;
    assert.deepEqual((await instance.settings(identity(ids.a))).partnerTo,defaults.partnerTo);
  });
  for(const [label,value]of [['missing',null],['blank',''],['invalid','{'],['override',JSON.stringify({accessoriesEmail:'agent@example.invalid',
    accessoriesCc:['duplicate@example.invalid','duplicate@example.invalid',''],partnerTo:[],weeklyLimit:7,unknown:'ignored'})],
    ['wrong-fields','{"accessoriesEmail":2,"standsCc":["ok@example.invalid",2],"partnerCc":false}'],['null','null'],['number','1']]){
    await check('agent_override:'+label,async()=>{
      if(value!==null)await put('agent-mail:'+ids.a,value);
      await oracle('read','settingsForAgent',[ids.a],'a',()=>repo().settingsForAgent(identity(ids.a),ids.a));
    });
  }
  await check('regional_active_assignment_order_and_mixed_routes',async()=>{
    await put('agent-mail:'+ids.b,'{"accessoriesEmail":"b@example.invalid"}');
    await put('agent-mail:'+ids.inactive,'{"accessoriesEmail":"inactive@example.invalid"}');
    await oracle('read','regionalOperationalSettings',[ids.regional],'regional',()=>repo().regionalOperationalSettings(identity(ids.regional)));
    assert.deepEqual((await repo().regionalOperationalSettings(identity(ids.regional))).agentIds,[ids.a,ids.b]);
  });
  await check('regional_fallback_no_active_agents',async()=>oracle('read','regionalOperationalSettings',[ids.empty],'empty',
    ()=>repo().regionalOperationalSettings(identity(ids.empty))));
  await check('regional_unknown_nul_id_preserves_native_fallback_and_pg_parameters',async()=>{
    const id='missing\u0000manager',seen=[];
    const actual=await database.read(tx=>api.readRegionalSettingsSnapshot(tx,s,defaults,id));
    await oracle('read','regionalOperationalSettings',[id],'regional',async()=>actual);
    assert.deepEqual(await database.read(tx=>api.readRegionalSettingsSnapshot(pgParameterReader(tx,seen),s,defaults,id)),actual);
    assert.equal(seen.filter(item=>item.binary).length,1);
  });
  await check('order_unknown_nul_id_preserves_native_fallback_and_pg_parameters',async()=>{
    const order={userId:'missing\u0000agent'},seen=[];
    const actual=await database.read(tx=>api.readOrderSettingsSnapshot(tx,s,defaults,order));
    await oracle('read','settingsForOrder',[order],'regional',async()=>actual);
    assert.deepEqual(await database.read(tx=>api.readOrderSettingsSnapshot(pgParameterReader(tx,seen),s,defaults,order)),actual);
    assert.equal(seen.filter(item=>item.binary).length,2);
  });
  await check('national_manager_public_order_unknown_nul_id_fallback',async()=>{
    const order={userId:'missing\u0000agent'},seen=[],actual=await repo().settingsForOrder(identity(ids.regional),order);
    await oracle('read','settingsForOrder',[order],'regional',async()=>actual);
    const wrapped={close:async()=>{},write:()=>{throw new Error('Read must not write');},
      read:action=>database.read(tx=>action(pgParameterReader(tx,seen)))};
    assert.deepEqual(await repo(wrapped).settingsForOrder(identity(ids.regional),order),actual);
    assert.equal(seen.filter(item=>item.binary).length,2);
  });
  await check('ordinary_routing_ids_keep_text_predicates',async()=>{
    const seen=[];
    await database.read(async tx=>{
      assert.deepEqual(await api.readRegionalSettingsSnapshot(pgParameterReader(tx,seen),s,defaults,ids.regional),
        await api.readRegionalSettingsSnapshot(tx,s,defaults,ids.regional));
      assert.deepEqual(await api.readOrderSettingsSnapshot(pgParameterReader(tx,seen),s,defaults,{userId:ids.a}),
        await api.readOrderSettingsSnapshot(tx,s,defaults,{userId:ids.a}));
    });
    assert(seen.length>0);assert(seen.every(item=>!item.binary&&!item.sql.includes('convert_to(')));
  });
  for(const value of [null,'{}','{"stands":"stand@example.invalid"}','{"accessories":"a@example.invalid","partner":""}',
    '{','null','1','{"accessories":null,"sim":false,"partner":2}'])await check('manager_mail_read:'+(value===null?'absent':JSON.stringify(value)),async()=>{
    if(value!==null)await put('manager-mail:'+ids.regional,value);
    await oracle('read','managerMailSettings',[ids.regional],'regional',()=>repo().managerMailSettings(identity(ids.regional)));
  });
  await check('order_mail_username_order_exact_dedupe_active_managers',async()=>{
    await put('app',JSON.stringify({accessoriesCc:['same@example.invalid','same@example.invalid','base@example.invalid'],
      standsCc:['stand@example.invalid'],simCc:[],partnerTo:['partner@example.invalid'],partnerCc:[],weeklyLimit:2}));
    await put('manager-mail:'+ids.regional,JSON.stringify({accessories:'same@example.invalid',stands:'second@example.invalid',sim:'r@example.invalid',partner:'unused@example.invalid'}));
    await put('manager-mail:'+ids.second,JSON.stringify({accessories:'new@example.invalid',sim:'s@example.invalid'}));
    await put('manager-mail:'+ids.off,'{"accessories":"inactive@example.invalid"}');
    await write(`UPDATE ${s}.users SET username='a-second' WHERE id=?`,[ids.second],`UPDATE ${s}.users SET username='a-second' WHERE id=$1`);
    await oracle('read','settingsForOrder',[{userId:ids.a}],'a',()=>repo().settingsForOrder(identity(ids.a),{userId:ids.a}));
    assert.deepEqual((await repo().settingsForOrder(identity(ids.a),{userId:ids.a})).accessoriesCc,
      ['same@example.invalid','base@example.invalid','new@example.invalid']);
  });
  for(const value of ['{','null','{"accessories":false}',''])await check('order_manager_mail_shape:'+value,async()=>{
    await put('manager-mail:'+ids.regional,value);
    await oracle('read','settingsForOrder',[{userId:ids.a}],'a',()=>repo().settingsForOrder(identity(ids.a),{userId:ids.a}));
  });
  await check('public_read_scope_national_manager_and_own_agent',async()=>{
    await repo().settingsForAgent(identity(ids.regional),ids.b);
    await repo().settingsForAgent(identity(ids.second),ids.b);
    await reject(()=>repo().settingsForAgent(identity(ids.a),ids.b),403);
    await reject(()=>repo().settingsForOrder(identity(ids.a),{userId:ids.b}),403);
    await reject(()=>repo().managerMailSettings(identity(ids.a)),403);
    await reject(()=>repo().regionalOperationalSettings(identity(ids.a)),403);
  });
  for(const [label,changed]of [['wrong-token',{tokenHash:'missing'}],['wrong-user',{userId:ids.b}],['inactive',{userId:ids.off,tokenHash:ids.off+'-token'}]]){
    if(typeof label!=='string')throw new Error('Invalid fictional session case label');
    await check('read_session_guard:'+label,async()=>reject(()=>repo().settings({...identity(ids.a),...changed}),401));
  }
  await check('read_password_change_and_expiry_guards',async()=>{
    await write(`UPDATE ${s}.users SET must_change_password=1 WHERE id=?`,[ids.regional],`UPDATE ${s}.users SET must_change_password=1 WHERE id=$1`);
    await reject(()=>repo().settings(identity(ids.regional)),428);now=NOW+10000;
    await reject(()=>repo().settings(identity(ids.a)),401);
  });
  await check('composable_helpers_share_existing_writer_and_defaults_snapshot',async()=>{
    await database.write(async tx=>{
      const input=structuredClone(defaults);let first=true;
      const wrapper={dialect:tx.dialect,query:(...args)=>{if(first){first=false;input.partnerTo[0]='changed@example.invalid';}return tx.query(...args);}};
      assert.deepEqual((await api.readAppSettingsSnapshot(wrapper,s,input)).cfg.partnerTo,defaults.partnerTo);
      await query(tx,'write',`INSERT INTO ${s}.settings VALUES('app',?)`,['{"weeklyLimit":6}'],`INSERT INTO ${s}.settings VALUES('app',$1)`);
      assert.equal((await api.readAgentSettingsSnapshot(tx,s,defaults,ids.a)).weeklyLimit,6);
      assert.equal((await api.readOrderSettingsSnapshot(tx,s,defaults,{userId:ids.a})).weeklyLimit,6);
      assert.deepEqual((await api.readRegionalSettingsSnapshot(tx,s,defaults,ids.regional)).agentIds,[ids.a,ids.b]);
      assert.equal((await api.readManagerMailSettingsSnapshot(tx,s,ids.regional)).partner,'');
    });
  });
  await check('helpers_reject_unqualified_schema',async()=>database.read(async tx=>{
    for(const invalid of ['main','"main".settings','"Mixed"'])for(const action of [
      ()=>api.readAppSettingsSnapshot(tx,invalid,defaults),()=>api.readAgentSettingsSnapshot(tx,invalid,defaults,ids.a),
      ()=>api.readRegionalSettingsSnapshot(tx,invalid,defaults,ids.regional),()=>api.readManagerMailSettingsSnapshot(tx,invalid,ids.regional),
      ()=>api.readOrderSettingsSnapshot(tx,invalid,defaults,{userId:ids.a})])await assert.rejects(action,/quoted application schema/);
  }));

  await check('global_save_absent_insert_exact_storage_sentinel',async()=>{
    const snapshot=await actor();await oracle('write','settings',[{...appBody,weeklyLimit:0}],'global',()=>update({...appBody,weeklyLimit:0},database,snapshot));
    assert.equal(JSON.parse(await raw('app')).weeklyLimit,2147483647);
  });
  await check('global_save_preserves_unknown_props_and_unsubmitted_arrays',async()=>{
    await put('app','{ "weeklyLimit": 2, "unknown": {"nested":[1]}, "accessoriesCc":["keep@example.invalid"], "partnerTo":["partner@example.invalid"] }');
    const snapshot=await actor();await oracle('write','settings',[{weeklyLimit:7}],'global',()=>update({weeklyLimit:7},database,snapshot));
    const stored=JSON.parse(await raw('app'));assert.deepEqual(stored.unknown,{nested:[1]});assert.equal(stored.accessoriesEmail,'');
  });
  await check('global_save_exact_email_array_order_blanks_and_duplicates',async()=>{
    const body={...appBody,accessoriesCc:[' first@example.invalid ','','first@example.invalid'],partnerCc:[' archive@example.invalid '],partnerTo:['partner@example.invalid','']};
    const snapshot=await actor();await oracle('write','settings',[body],'global',()=>update(body,database,snapshot));
  });
  for(const weeklyLimit of [null,'0',-1,8,1.5,true,{},[],undefined])await check('global_invalid_input_limit:'+(weeklyLimit===undefined?'missing':JSON.stringify(weeklyLimit)),async()=>{
    const snapshot=await actor(),body={...appBody,weeklyLimit};
    await oracle('write','settings',[body],'global',()=>update(body,database,snapshot));assert.equal(await raw('app'),null);
  });
  for(const value of [0,7,2147483647])await check('explicit_invalid_limit_repair:'+value,async()=>{
    await put('app','{ "weeklyLimit" : "bad", "unknown" : {"x":1}, "partnerTo":[], "accessoriesCc":null }');
    const body={weeklyLimit:value,repairWeeklyLimit:true},snapshot=await actor();
    await oracle('write','settings',[body],'global',()=>update(body,database,snapshot));
    assert.deepEqual(JSON.parse(await raw('app')),{weeklyLimit:value===7?7:2147483647,unknown:{x:1},partnerTo:[],accessoriesCc:null});
  });
  for(const body of [{weeklyLimit:3},{weeklyLimit:3,repairWeeklyLimit:false},{weeklyLimit:3,repairWeeklyLimit:true,accessoriesEmail:''},
    {weeklyLimit:3,repairWeeklyLimit:true,extra:null},{repairWeeklyLimit:true}])await check('repair_requires_exact_body:'+JSON.stringify(body),async()=>{
    await put('app','{"weeklyLimit":99,"unknown":"kept"}');const snapshot=await actor();
    await oracle('write','settings',[body],'global',()=>update(body,database,snapshot));assert.equal(await raw('app'),'{"weeklyLimit":99,"unknown":"kept"}');
  });
  for(const repair of [true,false,null])await check('valid_config_refuses_repair_field:'+String(repair),async()=>{
    const body={...appBody,repairWeeklyLimit:repair},snapshot=await actor();
    await oracle('write','settings',[body],'global',()=>update(body,database,snapshot));
  });
  for(const [field,limit]of [['accessoriesCc',4],['standsCc',4],['simCc',2],['partnerTo',2],['partnerCc',1]]){
    for(const [label,value]of [['overflow',Array.from({length:limit+1},()=> 'x@example.invalid')],['not-array','x@example.invalid'],
      ['not-string',[null]],['too-long',['a'.repeat(255)]],['invalid',['x@example.invalid,y@example.invalid']]]){
      await check('recipient_validation:'+field+':'+label,async()=>{
        const body={...appBody,[field]:value},snapshot=await actor();await oracle('write','settings',[body],'global',()=>update(body,database,snapshot));
      });
    }
  }
  for(const body of [{...appBody,partnerTo:[]},{...appBody,partnerTo:['',' ']},{...appBody,accessoriesEmail:'two@example.invalid;three@example.invalid'},
    {...appBody,accessoriesEmail:42},{...appBody,accessoriesEmail:'x'.repeat(260)+'@example.invalid'}]){
    await check('global_scalar_and_required_recipient:'+JSON.stringify(body),async()=>{
      const snapshot=await actor();await oracle('write','settings',[body],'global',()=>update(body,database,snapshot));
    });
  }
  await check('regional_save_assigns_only_active_owned_agents_and_keeps_optional',async()=>{
    await put('agent-mail:'+ids.a,'{"standsEmail":"kept@example.invalid","partnerTo":["first@example.invalid"]}');
    await put('agent-mail:'+ids.b,'{"standsEmail":"other@example.invalid"}');
    await put('agent-mail:'+ids.inactive,'{"standsEmail":"inactive@example.invalid"}');
    const snapshot=await actor('regional'),body={accessoriesEmail:' new@example.invalid ',simCc:['sim@example.invalid']};
    await oracle('write','regional-settings',[body],'regional',()=>repo().updateRegionalSettings(snapshot,body));
    assert.equal(await raw('agent-mail:'+ids.a),await raw('agent-mail:'+ids.b));
    assert.equal(await raw('agent-mail:'+ids.inactive),'{"standsEmail":"inactive@example.invalid"}');
  });
  await check('regional_global_and_empty_scope_write_rejected',async()=>{
    await reject(()=>actor().then(value=>repo().updateRegionalSettings(value,{})),403);
    await reject(()=>actor('empty').then(value=>repo().updateRegionalSettings(value,{})),409);
    await reject(()=>actor('a').then(value=>repo().updateRegionalSettings(value,{})),403);
  });
  await check('regional_optional_emails_and_unknown_fields_match_legacy',async()=>{
    const snapshot=await actor('regional'),body={unknown:1,weeklyLimit:7};
    await oracle('write','regional-settings',[body],'regional',()=>repo().updateRegionalSettings(snapshot,body));
  });
  for(const body of [{},{accessories:' a@example.invalid ',stands:'s@example.invalid',partner:'p@example.invalid'},
    {sim:55},{partner:'bad;mail@example.invalid'},{accessories:'a@example.invalid',extra:'ignored'}]){
    await check('manager_mail_write:'+JSON.stringify(body),async()=>{
      await put('manager-mail:'+ids.regional,'{"stands":"old@example.invalid","extra":"removed"}');
      const snapshot=await actor('regional');await oracle('write','manager-mail',[body],'regional',()=>repo().updateManagerMailSettings(snapshot,body));
    });
  }
  await check('manager_mail_malformed_existing_is_not_silently_repaired',async()=>{
    await put('manager-mail:'+ids.regional,'{');const snapshot=await actor('regional');
    await oracle('write','manager-mail',[{accessories:'new@example.invalid'}],'regional',()=>repo().updateManagerMailSettings(snapshot,{accessories:'new@example.invalid'}));
  });
  await check('global_only_app_write_does_not_expand_regional_scope',async()=>{
    await reject(()=>actor('regional').then(value=>repo().updateAppSettings(value,appBody)),403);
    await reject(()=>actor('a').then(value=>repo().updateAppSettings(value,appBody)),403);
    assert.deepEqual(await settings(),[]);
  });

  for(const [label,sql,values,pg]of [
    ['logout',`DELETE FROM ${s}.sessions WHERE token_hash=?`,[ids.global+'-token'],`DELETE FROM ${s}.sessions WHERE token_hash=$1`],
    ['expiry',`UPDATE ${s}.sessions SET expires_at=? WHERE token_hash=?`,[NOW,ids.global+'-token'],`UPDATE ${s}.sessions SET expires_at=$1 WHERE token_hash=$2`],
    ['active',`UPDATE ${s}.users SET active=0 WHERE id=?`,[ids.global],`UPDATE ${s}.users SET active=0 WHERE id=$1`],
    ['role',`UPDATE ${s}.users SET role='agent' WHERE id=?`,[ids.global],`UPDATE ${s}.users SET role='agent' WHERE id=$1`],
    ['scope',`UPDATE ${s}.users SET manager_scope='assigned' WHERE id=?`,[ids.global],`UPDATE ${s}.users SET manager_scope='assigned' WHERE id=$1`],
    ['password',`UPDATE ${s}.users SET must_change_password=1 WHERE id=?`,[ids.global],`UPDATE ${s}.users SET must_change_password=1 WHERE id=$1`],
    ['profile',`UPDATE ${s}.users SET profile_revision=profile_revision+1 WHERE id=?`,[ids.global],`UPDATE ${s}.users SET profile_revision=profile_revision+1 WHERE id=$1`],
    ['warehouse',`UPDATE ${s}.users SET warehouse_id='changed' WHERE id=?`,[ids.global],`UPDATE ${s}.users SET warehouse_id='changed' WHERE id=$1`],
    ['assignment',`DELETE FROM ${s}.manager_agents WHERE manager_id=?`,[ids.global],`DELETE FROM ${s}.manager_agents WHERE manager_id=$1`],
  ])for(const order of ['revoke-first','write-first'])await check('authority_order:'+label+':'+order,async()=>{
    const snapshot=await actor();
    if(order==='write-first')await update(appBody,database,snapshot);
    await write(sql,values,pg,other);
    if(order==='revoke-first'){await reject(()=>update(appBody,database,snapshot),409);assert.equal(await raw('app'),null);}
    else assert.equal(JSON.parse(await raw('app')).weeklyLimit,3);
  });
  await check('captured_wrong_session_and_profile_or_scope_snapshot',async()=>{
    const snapshot=await actor();
    for(const change of [{tokenHash:'missing'},{userId:ids.regional},{profileVersion:2},{scopeRevision:snapshot.scopeRevision-1}]){
      await reject(()=>update(appBody,database,{...snapshot,...change}),409);
    }assert.deepEqual(await settings(),[]);
  });
  for(const method of ['app','regional','manager'])await check('expiry_after_write_rolls_back:'+method,async()=>{
    const who=method==='app'?'global':'regional',snapshot=await actor(who),before=await settings();
    const wrapped=proxy(database,{afterWrite:()=>{now=NOW+10000;}}),instance=repo(wrapped);
    await reject(()=>method==='app'?instance.updateAppSettings(snapshot,appBody):method==='regional'?
      instance.updateRegionalSettings(snapshot,{accessoriesEmail:'new@example.invalid'}):instance.updateManagerMailSettings(snapshot,{sim:'new@example.invalid'}),409);
    assert.deepEqual(await settings(),before);
  });
  await check('expiry_clock_is_read_after_waiting_for_writer',async()=>{
    const snapshot=await actor(),entered=deferred(),release=deferred();
    const first=other.write(async()=>{entered.resolve();await release.promise;});await entered.promise;
    const attempted=update(appBody,database,snapshot),outcome=attempted.then(()=>({passed:true}),error=>({error}));
    now=NOW+10000;release.resolve();await first;const result=await outcome;
    assert.equal(result.error?.status,409);assert.equal(await raw('app'),null);
  });
  for(const kind of ['present','absent','repair'])await check('raw_cas_failure_has_no_effect:'+kind,async()=>{
    if(kind!=='absent')await put('app',kind==='repair'?'{"weeklyLimit":99}':'{ "weeklyLimit":2 }');
    const before=await settings(),snapshot=await actor();let injected=false;
    const wrapped=proxy(database,{writeHook:async(tx,statement,values)=>{
      if(!injected&&statement.kind==='write'&&statement.sqlite.includes('.settings')){
        injected=true;
        await query(tx,'write',`INSERT INTO ${s}.settings VALUES('app','{"weeklyLimit":4}') ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
      }
      return tx.query(statement,values);
    }});
    await reject(()=>update(kind==='repair'?{weeklyLimit:3,repairWeeklyLimit:true}:appBody,wrapped,snapshot),409,'settings_changed');
    assert(injected);assert.deepEqual(await settings(),before);
  });
  await check('regional_second_write_failure_rolls_back_first',async()=>{
    await put('agent-mail:'+ids.a,'{"accessoriesEmail":"original@example.invalid"}');
    const before=await settings(),snapshot=await actor('regional');let writes=0;
    const wrapped=proxy(database,{writeHook:(tx,statement,values)=>{
      if(statement.kind==='write'&&++writes===2)throw new Error('Synthetic second settings write failure');return tx.query(statement,values);
    }});
    await assert.rejects(()=>repo(wrapped).updateRegionalSettings(snapshot,{accessoriesEmail:'new@example.invalid'}),/second settings write failure/);
    assert.equal(writes,2);assert.deepEqual(await settings(),before);
  });
  for(const method of ['app','manager'])await check('failure_after_mutation_rolls_back:'+method,async()=>{
    const snapshot=await actor(),before=await settings(),wrapped=proxy(database,{afterWrite:()=>{throw new Error('Synthetic post-mutation failure');}});
    await assert.rejects(()=>method==='app'?update(appBody,wrapped,snapshot):repo(wrapped).updateManagerMailSettings(snapshot,{sim:'new@example.invalid'}),/post-mutation failure/);
    assert.deepEqual(await settings(),before);
  });
  await check('queued_repair_observes_other_connection_correction',async()=>{
    await put('app','{"weeklyLimit":99,"unknown":"first"}');const snapshot=await actor(),entered=deferred(),release=deferred();
    const first=other.write(async tx=>{
      await query(tx,'write',`UPDATE ${s}.settings SET value='{"weeklyLimit":4,"unknown":"committed"}' WHERE key='app'`);
      entered.resolve();await release.promise;
    });await entered.promise;
    const attempted=update({weeklyLimit:3,repairWeeklyLimit:true},database,snapshot).then(()=>({passed:true}),error=>({error}));
    release.resolve();await first;const result=await attempted;
    assert.equal(result.error?.code,'weekly_limit_already_repaired');assert.equal(await raw('app'),'{"weeklyLimit":4,"unknown":"committed"}');
  });
  await check('queued_normal_save_reads_latest_raw_and_captures_input',async()=>{
    const snapshot={...await actor()},input={...appBody,partnerTo:['captured@example.invalid']},entered=deferred(),release=deferred();
    const first=other.write(async tx=>{
      await query(tx,'write',`INSERT INTO ${s}.settings VALUES('app','{"weeklyLimit":2,"concurrent":"retained"}')`);
      entered.resolve();await release.promise;
    });await entered.promise;
    const attempted=update(input,database,snapshot);input.partnerTo[0]='mutated@example.invalid';input.weeklyLimit=7;snapshot.profileVersion=88;
    release.resolve();await first;await attempted;
    const result=JSON.parse(await raw('app'));assert.equal(result.concurrent,'retained');assert.equal(result.weeklyLimit,3);assert.deepEqual(result.partnerTo,['captured@example.invalid']);
  });
  await check('regional_assignment_change_while_queued_cannot_write_wrong_agents',async()=>{
    const snapshot=await actor('regional'),entered=deferred(),release=deferred();
    const first=other.write(async tx=>{
      await query(tx,'write',`DELETE FROM ${s}.manager_agents WHERE manager_id=? AND agent_id=?`,[ids.regional,ids.b],
        `DELETE FROM ${s}.manager_agents WHERE manager_id=$1 AND agent_id=$2`);entered.resolve();await release.promise;
    });await entered.promise;
    const attempted=repo().updateRegionalSettings(snapshot,{simEmail:'new@example.invalid'}).then(()=>({passed:true}),error=>({error}));
    release.resolve();await first;assert.equal((await attempted).error?.status,409);assert.deepEqual(await settings(),[]);
  });
  if(!fixture.concurrentWrite)throw new Error('An independent commit callback is required for snapshot tests');
  for(const method of ['agent','regional','order'])await check('coherent_read_snapshot_during_independent_commit:'+method,async()=>{
    await put('app','{"weeklyLimit":2}');await put('agent-mail:'+ids.a,'{"simEmail":"old@example.invalid"}');
    const before=method==='agent'?await repo().settingsForAgent(identity(ids.a),ids.a):method==='regional'?
      await repo().regionalOperationalSettings(identity(ids.regional)):await repo().settingsForOrder(identity(ids.a),{userId:ids.a});
    let committed=false;
    const wrapped=proxy(database,{readHook:async(tx,statement,values)=>{
      const result=await tx.query(statement,values);
      if(!committed&&statement.sqlite.includes('.settings WHERE key=?')&&values[0]==='app'){
        committed=true;await fixture.concurrentWrite([
          {query:q('write',`UPDATE ${s}.settings SET value='{"weeklyLimit":7}' WHERE key='app'`),values:[]},
          {query:q('write',`UPDATE ${s}.settings SET value='{"simEmail":"new@example.invalid"}' WHERE key=?`,
            `UPDATE ${s}.settings SET value='{"simEmail":"new@example.invalid"}' WHERE key=$1`),values:['agent-mail:'+ids.a]},
          {query:q('write',`DELETE FROM ${s}.manager_agents WHERE manager_id=?`, `DELETE FROM ${s}.manager_agents WHERE manager_id=$1`),values:[ids.regional]},
        ]);
      }return result;
    }});
    const actual=method==='agent'?await repo(wrapped).settingsForAgent(identity(ids.a),ids.a):method==='regional'?
      await repo(wrapped).regionalOperationalSettings(identity(ids.regional)):await repo(wrapped).settingsForOrder(identity(ids.a),{userId:ids.a});
    assert(committed);assert.deepEqual(actual,before);assert.equal(JSON.parse(await raw('app')).weeklyLimit,7);
  });
  return cases;
}
