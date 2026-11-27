// Fictional, reusable read contract. Caller owns the isolated schema, two real
// adapters, and (for SQLite) an independent WAL writer for in-snapshot races.
import assert from 'node:assert/strict';

const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
const BASE_TIME=Date.parse('2026-11-27T12:00:00Z');
const identity=id=>({userId:id,tokenHash:id+'-token'});
const ACTORS={global:'fixture-global',regional:'fixture-region-a',regionalB:'fixture-region-b',
  inactive:'fixture-region-inactive',empty:'fixture-region-empty',a:'fixture-agent-a',b:'fixture-agent-b',
  c:'fixture-agent-c',d:'fixture-agent-d'};

export async function runOrderListContract(api,fixture){
  const {database,other,applicationSchema}=fixture,a=api.sqlIdentifier(applicationSchema),cases=[];
  const q=(kind,sqlite,postgresql=sqlite)=>api.sqlQuery(kind,sqlite,postgresql);
  const query=(tx,kind,sql,values=[],pg=sql)=>tx.query(q(kind,sql,pg),values);
  const read=(sql,values=[],pg=sql)=>database.read(tx=>query(tx,'read',sql,values,pg));
  const write=(sql,values=[],pg=sql)=>database.write(tx=>query(tx,'write',sql,values,pg));
  const revision=async()=>String((await read(`SELECT revision FROM ${a}.order_list_revision WHERE id=1`)).rows[0].revision);
  let now=BASE_TIME;
  const repo=(db=database)=>new api.OrderListRepository(db,applicationSchema,()=>now);
  const params=(value='')=>new URLSearchParams('kind=all&range=all'+(value?'&'+value:''));
  const page=(value='',actor='global',db=database)=>repo(db).listOrdersPage(identity(ACTORS[actor]),params(value));
  const putOrder=async(tx,id,owner,overrides={})=>{
    const kind=overrides.kind??'accessories',status=overrides.status??'draft';
    const createdAt=overrides.createdAt??'2026-11-10T10:00:00Z',finalizedAt=overrides.finalizedAt??null;
    const payload={id,number:'Fictional order '+id,userId:owner,warehouseId:'fixture-warehouse',
      agentName:'Agent fictiv Ștefan',warehouseName:'Depozit fictiv Brașov',kind,status,createdAt,finalizedAt,
      sourceOrderId:null,revision:1,items:[{id:'fictional-product-a'},{id:'fictional-product-b'}],standItems:[{id:'fictional-stand'}],
      serials:['FICTIONAL-SERIAL'],exportKey:'fictional-private-export',itemCount:999,
      client:{name:id==='a1'?'Client fictiv Mărțișor':'Client fictiv',cui:'FICTIVE-'+id},notes:'Fictional note',
      total:1.25,pieces:3,...overrides.payload};
    const columns='id,number,user_id,warehouse_id,kind,status,payload,created_at,finalized_at,week_key,source_order_id,revision';
    const values=[id,payload.number,owner,'fixture-warehouse',kind,status,JSON.stringify(payload),createdAt,finalizedAt,
      overrides.weekKey??null,null,overrides.revision??1];
    return query(tx,'write',`INSERT INTO ${a}.orders(${columns}) VALUES(${values.map(()=>'?').join(',')})`,values,
      `INSERT INTO ${a}.orders(${columns}) VALUES(${values.map((_,i)=>'$'+(i+1)).join(',')})`);
  };
  async function reset(){
    now=BASE_TIME;
    await database.write(async tx=>{
      for(const table of ['serials','order_limit_approvals','orders','sessions','manager_agents','users'])await query(tx,'write',`DELETE FROM ${a}.${table}`);
      for(const [name,id]of Object.entries(ACTORS)){
        const manager=['global','regional','regionalB','inactive','empty'].includes(name);
        const values=[id,id,'Fictional '+name,manager?'manager':'agent',name==='global'?'global':'assigned',
          'fixture-warehouse','Fictional warehouse','FICTIVE-SITE-'+name,'not-a-credential',0,['inactive','c'].includes(name)?0:1,1];
        const columns='id,username,name,role,manager_scope,warehouse_id,warehouse_name,site_code,password_hash,must_change_password,active,profile_revision';
        await query(tx,'write',`INSERT INTO ${a}.users(${columns}) VALUES(${values.map(()=>'?').join(',')})`,values,
          `INSERT INTO ${a}.users(${columns}) VALUES(${values.map((_,i)=>'$'+(i+1)).join(',')})`);
        await query(tx,'write',`INSERT INTO ${a}.sessions VALUES(?,?,?)`,[id+'-token',id,BASE_TIME+86400000],
          `INSERT INTO ${a}.sessions VALUES($1,$2,$3)`);
      }
      for(const [manager,agent]of [['regional','a'],['regionalB','b'],['inactive','c'],['global','d']])
        await query(tx,'write',`INSERT INTO ${a}.manager_agents VALUES(?,?)`,[ACTORS[manager],ACTORS[agent]],`INSERT INTO ${a}.manager_agents VALUES($1,$2)`);
      for(const [id,agent,values]of [
        ['a0','a',{}],['a1','a',{status:'finalized',createdAt:'2026-11-27T10:00:00Z',finalizedAt:'2026-11-27T10:01:00Z',weekKey:'2026-11-23'}],
        ['a2','a',{kind:'sim',status:'finalized',createdAt:'2026-11-27T10:00:00Z',finalizedAt:'2026-11-27T10:02:00Z',weekKey:'2026-11-23'}],
        ['b0','b',{kind:'stands',createdAt:'2026-11-27T10:00:00Z'}],
        ['b1','b',{kind:'combined',status:'finalized',createdAt:'2026-10-10T10:00:00Z',finalizedAt:'2026-10-11T10:00:00Z',weekKey:'2026-10-05'}],
        ['c0','c',{kind:'stand_client',createdAt:'2026-11-20T10:00:00Z'}],['d0','d',{status:'deleted'}]])await putOrder(tx,id,ACTORS[agent],values);
      await query(tx,'write',`UPDATE ${a}.order_list_revision SET revision=100 WHERE id=1`);
    });
  }
  const check=async(name,action)=>{try{await reset();await action();assert(!cases.includes(name));cases.push(name);}
    catch(error){error.message='Contract case '+name+': '+error.message;throw error;}};
  const rejects=async(action,status,code)=>assert.rejects(action,error=>error.status===status&&(!code||error.code===code));
  const ids=result=>result.orders.map(row=>row.id);
  const explicit=value=>new URLSearchParams(value);

  await check('legacy_compact_projection_and_deterministic_ties',async()=>{
    const rows=await repo().listOrders(identity(ACTORS.global));
    assert.deepEqual(rows.map(row=>row.id),['b0','a2','a1','c0','a0','b1']);
    for(const row of rows){assert.deepEqual(row.items,[]);assert.deepEqual(row.standItems,[]);assert.deepEqual(row.serials,[]);
      assert.equal(row.itemCount,3);assert.equal(row.exportKey,undefined);assert.equal(row.total,1.25);assert.equal(row.notes,'Fictional note');}
  });
  for(const [actor,expected]of [['global',6],['regional',6],['regionalB',6],['empty',6],['a',3],['b',2]]){
    await check('national_read_or_agent_scope:'+actor,async()=>{
      assert.equal((await page('',actor)).orderPage.total,expected);
      assert.equal((await repo().listOrders(identity(ACTORS[actor]))).length,expected);
    });
  }
  await check('read_methods_never_use_writer_transaction',async()=>{
    const guarded={read:database.read.bind(database),write:()=>assert.fail('A read repository wrote'),close:async()=>{}};
    const before=await revision();await page('', 'global',guarded);await repo(guarded).listOrders(identity(ACTORS.global));assert.equal(await revision(),before);
  });
  for(const [suffix,expected]of [['',40],['0',1],['-4',1],['101',100],['1.5',40],['no',40],['9007199254740992',40],['2',2],['2e0',2]]){
    await check('limit_contract:'+suffix,async()=>assert.equal((await page('limit='+suffix)).orderPage.limit,expected));
  }
  for(const {kind,total,stats}of [{kind:'orders',total:4,stats:{drafts:2,weekly:1}},
    {kind:'sim',total:2,stats:{drafts:1,weekly:1}},{kind:'all',total:6,stats:{drafts:3,weekly:2}}]){
    await check('kind_and_stats:'+kind,async()=>{
      const result=await repo().listOrdersPage(identity(ACTORS.global),explicit('kind='+kind+'&range=all'));
      assert.equal(result.orderPage.total,total);assert.deepEqual(result.orderPage.stats,stats);
    });
  }
  for(const [value,total]of [['status=draft',3],['status=finalized',3],['q=martisor',1],['q=absent-fictional',0]]){
    await check('stats_ignore_row_only_filter:'+value,async()=>{
      const result=await page(value);assert.equal(result.orderPage.total,total);assert.deepEqual(result.orderPage.stats,{drafts:3,weekly:2});
    });
  }
  for(const [query,expected]of [[' ȘTEFAN ',6],['stefan',6],['braSOV',6],['MARTISOR',1],['FICTIVE-a1',1],['order b0',1],['Ma\u0306rt\u0326is\u0326or',1]]){
    await check('romanian_search:'+query,async()=>assert.equal((await page('q='+encodeURIComponent(query))).orderPage.total,expected));
  }
  for(const [range,total]of [['day',5],['7d',5],['30d',5],['all',6]]){
    await check('range_preserves_old_drafts:'+range,async()=>{
      const result=await repo().listOrdersPage(identity(ACTORS.global),explicit('kind=all&range='+range));
      assert.equal(result.orderPage.total,total);assert(result.orders.some(order=>order.id==='a0'));
    });
  }
  for(const [filter,expected]of [
    ['managerId='+ACTORS.regional,['a2','a1','a0']],['managerId='+ACTORS.regionalB,['b0','b1']],
    ['managerId='+ACTORS.empty,[]],['managerId=__unassigned',['c0']],['agentId='+ACTORS.c,['c0']],
    ['managerId='+ACTORS.regional+'&agentId='+ACTORS.a,['a2','a1','a0']]]){
    await check('manager_read_filter:'+filter,async()=>assert.deepEqual(ids(await page(filter,'regional')),expected));
  }
  for(const filter of ['managerId='+ACTORS.global,'managerId='+ACTORS.inactive,'managerId=missing-fixture',
    'managerId='+ACTORS.regional+'&agentId='+ACTORS.b,'agentId='+ACTORS.global])
    await check('manager_filter_not_found:'+filter,async()=>rejects(()=>page(filter),404));
  for(const filter of ['managerId='+ACTORS.regional,'agentId='+ACTORS.a,'managerId=__unassigned'])
    await check('agent_cannot_select_foreign_filter:'+filter,async()=>rejects(()=>page(filter,'a'),403));
  for(const filter of ['kind=wrong','status=deleted','range=0'])
    await check('invalid_filter:'+filter,async()=>rejects(()=>repo().listOrdersPage(identity(ACTORS.global),explicit(filter)),400));
  await check('long_manager_filter_rejected',async()=>rejects(()=>page('managerId='+'x'.repeat(129)),400));
  await check('empty_manager_and_agent_filters_are_absent',async()=>assert.equal((await page('managerId=&agentId=')).orderPage.total,6));
  await check('duplicate_parameter_first_value_preserved',async()=>assert.equal((await page('limit=1&limit=100')).orderPage.limit,1));

  for(const search of ['', 'q=fictional']){
    await check('keyset_pages_full_order_total_stats:'+search,async()=>{
      let cursor=null;const seen=[],initial=await revision();
      do{
        const result=await page([search,'limit=2','revision='+initial,cursor?'cursor='+encodeURIComponent(cursor):''].filter(Boolean).join('&'));
        seen.push(...ids(result));cursor=result.orderPage.nextCursor;assert.equal(result.orderPage.total,6);
        assert.deepEqual(result.orderPage.stats,{drafts:3,weekly:2});assert.equal(result.orderPage.revision,initial);
      }while(cursor);
      assert.deepEqual(seen,['b0','a2','a1','c0','a0','b1']);assert.equal(new Set(seen).size,6);
    });
  }
  for(const raw of ['not-json',Buffer.from('{}').toString('base64url'),Buffer.from('[1,"a"]').toString('base64url'),
    Buffer.from('["a","b","c"]').toString('base64url'),Buffer.from(JSON.stringify(['x'.repeat(41),'a'])).toString('base64url'),
    Buffer.from(JSON.stringify(['a','x'.repeat(101)])).toString('base64url')])
    await check('invalid_cursor:'+raw.slice(0,30),async()=>rejects(()=>page('cursor='+encodeURIComponent(raw)),400,'invalid_order_cursor'));
  await check('stale_revision_precedes_malformed_cursor',async()=>{
    await assert.rejects(()=>page('revision=99&cursor=invalid'),error=>error.status===409&&error.currentRevision==='100');
  });
  for(const cursor of [{createdAt:'',id:''},{createdAt:'x'.repeat(40),id:'x'.repeat(100)},
    {createdAt:'2026-11-27T10:00:00+00:00',id:'a2'},{createdAt:'2026-11-27T10:00:00.000Z',id:'a2'},
    {createdAt:'2026-11-27T10:00:00Z',id:'a2\u0000z'},{createdAt:'2026-11-27T10:00:00Z',id:'a2\' OR 1=1 --'}]){
    for(const search of [false,true])await check('cursor_grammar_and_text_order:'+JSON.stringify(cursor)+':'+search,async()=>{
      const all=await repo().listOrders(identity(ACTORS.global));
      const compare=(x,y)=>search?(x<y?-1:x>y?1:0):Buffer.compare(Buffer.from(x),Buffer.from(y));
      const expected=all.filter(row=>compare(row.createdAt,cursor.createdAt)<0||row.createdAt===cursor.createdAt&&compare(row.id,cursor.id)<0).map(row=>row.id);
      const result=await page('cursor='+encodeURIComponent(api.encodeOrderListCursor(cursor))+(search?'&q=fictional':''));
      assert.deepEqual(ids(result),expected);
    });
  }
  for(const search of [false,true])await check('unicode_cursor_sql_vs_js_contract:'+search,async()=>{
    await database.write(async tx=>{for(const id of ['\uE000','😀','z'])await putOrder(tx,id,ACTORS.a,{createdAt:'2090-01-01T00:00:00Z'});});
    const cursor={createdAt:'2090-01-01T00:00:00Z',id:'\uE000'};
    const result=await page('cursor='+encodeURIComponent(api.encodeOrderListCursor(cursor))+(search?'&q=fictional':''));
    assert.deepEqual(ids(result).filter(id=>['\uE000','😀','z'].includes(id)),search?['😀','z']:['z']);
  });
  for(const cursor of [
    {createdAt:'2026-11-27T10:00:00Z',id:'a2\u0000z'},
    {createdAt:'2026-11-27T10:00:00Z\u0000z',id:'a2'},
    {createdAt:'\u0000',id:'\u0000'},
    {createdAt:'2026-11-27T10:00:00Z',id:'a2'},
  ])for(const search of [false,true])await check('cursor_postgresql_binary_bindings:'+JSON.stringify(cursor)+':'+search,async()=>{
    const input=params('cursor='+encodeURIComponent(api.encodeOrderListCursor(cursor))+(search?'&q=fictional':''));
    const expected=await repo().listOrdersPage(identity(ACTORS.global),input);let observed=0;
    // Exercise the repository's PostgreSQL parameter construction even in the
    // SQLite suite. This guard is not a PostgreSQL execution claim. On the real
    // PG fixture the same exact BYTEA values reach the native driver unchanged.
    const guarded={close:async()=>{},write:()=>assert.fail('Read repository wrote'),read:action=>database.read(tx=>action({
      dialect:'postgresql',query:async(query,values=[])=>{
        assert(!values.some(value=>typeof value==='string'&&value.includes('\u0000')),'NUL must never be bound as PostgreSQL TEXT');
        if(query.sqlite.startsWith('SELECT o.id,')){
          observed++;
          if(search){assert(!values.some(value=>value instanceof Uint8Array));assert(!query.postgresql.includes('convert_to('));}
          else{
            const keys=[cursor.createdAt,cursor.createdAt,cursor.id];
            assert.equal(values.length,4);
            keys.forEach((key,index)=>{
              if(key.includes('\u0000')){assert(values[index] instanceof Uint8Array);assert.deepEqual(Buffer.from(values[index]),Buffer.from(key,'utf8'));}
              else assert.equal(values[index],key);
            });
            assert.equal(query.postgresql.includes("convert_to(o.created_at,'UTF8')"),cursor.createdAt.includes('\u0000'));
            assert.equal(query.postgresql.includes("convert_to(o.id,'UTF8')"),cursor.id.includes('\u0000'));
          }
        }
        const nativeValues=tx.dialect==='sqlite'?values.map(value=>value instanceof Uint8Array?Buffer.from(value).toString('utf8'):value):values;
        return tx.query(query,nativeValues);
      },
    }))};
    assert.deepEqual(await repo(guarded).listOrdersPage(identity(ACTORS.global),input),expected);assert.equal(observed,1);
  });
  await check('empty_result_has_zero_counts_and_no_cursor',async()=>{
    await database.write(async tx=>{await query(tx,'write',`DELETE FROM ${a}.orders`);});
    const result=await page();assert.deepEqual(result.orders,[]);assert.equal(result.orderPage.total,0);
    assert.deepEqual(result.orderPage.stats,{drafts:0,weekly:0});assert.equal(result.orderPage.nextCursor,null);
  });
  for(const [time,range,boundary,week]of [
    ['2026-03-29T10:00:00Z','day','2026-03-28T22:00:00.000Z','2026-03-23'],
    ['2026-03-29T21:00:00Z','day','2026-03-29T21:00:00.000Z','2026-03-30'],
    ['2026-10-25T10:00:00Z','day','2026-10-24T21:00:00.000Z','2026-10-19'],
    ['2026-10-25T22:00:00Z','day','2026-10-25T22:00:00.000Z','2026-10-26'],
    ['2026-03-30T10:00:00Z','7d','2026-03-23T22:00:00.000Z','2026-03-30'],
    ['2026-10-26T10:00:00Z','7d','2026-10-19T21:00:00.000Z','2026-10-26'],
    ['2026-01-01T10:00:00Z','day','2025-12-31T22:00:00.000Z','2025-12-29']]){
    await check('bucharest_calendar_boundary:'+time+':'+range,async()=>{
      now=Date.parse(time);
      await database.write(async tx=>{await query(tx,'write',`DELETE FROM ${a}.orders`);
        for(const [id,milliseconds]of [['before',-1],['exact',0],['after',1]])await putOrder(tx,id,ACTORS.a,
          {status:'finalized',createdAt:new Date(Date.parse(boundary)+milliseconds).toISOString(),finalizedAt:null,weekKey:week});
        await putOrder(tx,'old-draft',ACTORS.a,{createdAt:'2000-01-01T00:00:00Z'});
      });
      const result=await repo().listOrdersPage(identity(ACTORS.global),explicit('kind=all&range='+range));
      assert.deepEqual(ids(result),['after','exact','old-draft']);assert.equal(result.weekKey,week);
      assert.deepEqual(result.orderPage.stats,{drafts:1,weekly:3});
    });
  }
  for(const [label,mutation,status]of [
    ['inactive',`UPDATE ${a}.users SET active=0 WHERE id='${ACTORS.global}'`,401],
    ['expired',`UPDATE ${a}.sessions SET expires_at=${BASE_TIME} WHERE user_id='${ACTORS.global}'`,401],
    ['missing',`DELETE FROM ${a}.sessions WHERE user_id='${ACTORS.global}'`,401],
    ['manager_password',`UPDATE ${a}.users SET must_change_password=1 WHERE id='${ACTORS.global}'`,428]]){
    await check('session_guard:'+label,async()=>{await write(mutation);await rejects(()=>page(),status);
      await rejects(()=>repo().listOrders(identity(ACTORS.global)),status);});
  }
  await check('wrong_user_with_valid_session_rejected',async()=>rejects(()=>repo().listOrdersPage(
    {userId:ACTORS.a,tokenHash:ACTORS.global+'-token'},params()),401));
  await check('agent_password_flag_does_not_invent_manager_only_block',async()=>{
    await write(`UPDATE ${a}.users SET must_change_password=1 WHERE id='${ACTORS.a}'`);assert.equal((await page('','a')).orderPage.total,3);
  });

  function stageMatches(stage,query){
    return stage==='count'?query.sqlite.startsWith('SELECT COUNT(*) AS count'):
      stage==='rows'?query.sqlite.startsWith('SELECT o.id,'):
      stage==='stats'?query.sqlite.startsWith('SELECT SUM(CASE'):
      query.sqlite.startsWith('SELECT revision FROM');
  }
  async function interleaved({stage,bound='',search=false,always=false}){
    const trigger=deferred(),committed=deferred(),stop=deferred(),firstSnapshot=[];let stopped=false,fired=0,snapshotCount=0;
    const mutation=q('write',`UPDATE ${a}.orders SET status=CASE status WHEN 'deleted' THEN 'draft' ELSE 'deleted' END,revision=revision+1 WHERE id='b0'`);
    // This driver is created outside the adapter's AsyncLocalStorage lifetime.
    // It must not be started from inside the read callback as a nested write.
    const driver=(async()=>{
      for(let index=0;index<(always?3:1);index++){
        await Promise.race([trigger.promise,stop.promise]);if(stopped)return;
        if(fixture.concurrentWrite)await fixture.concurrentWrite(mutation,[]);
        else await other.write(tx=>tx.query(mutation));
        committed.resolve();
        if(always&&index<2){trigger.promise=new Promise(done=>{trigger.resolve=done;});committed.promise=new Promise(done=>{committed.resolve=done;});}
      }
    })();
    const wrapped={close:async()=>{},write:()=>assert.fail('List writer forbidden'),read:action=>database.read(async tx=>{
      const number=++snapshotCount;let triggered=false;
      return action({dialect:tx.dialect,query:async(query,values)=>{
        const result=await tx.query(query,values);
        if(number===1)firstSnapshot.push({sql:query.sqlite,rows:structuredClone(result.rows)});
        if(!triggered&&stageMatches(stage,query)&&(always||fired===0)){
          triggered=true;fired++;trigger.resolve();await committed.promise;
        }
        return result;
      }});
    })};
    try{return {value:await page([search?'q=fictional':'',bound].filter(Boolean).join('&'),'global',wrapped),fired,firstSnapshot,snapshotCount};}
    catch(error){error.contract={fired,firstSnapshot,snapshotCount};throw error;}
    finally{stopped=true;stop.resolve();await driver;}
  }
  for(const stage of ['count','rows','stats','revision'])for(const bound of ['', 'revision=100', 'cursor='+encodeURIComponent(api.encodeOrderListCursor({createdAt:'2090',id:'z'}))]){
    await check('two_connection_snapshot_and_revision:'+stage+':'+(bound.split('=')[0]||'first'),async()=>{
      if(bound){await assert.rejects(()=>interleaved({stage,bound}),error=>error.status===409&&error.currentRevision==='101'&&error.contract.fired===1);}
      else{const result=await interleaved({stage});assert.equal(result.fired,1);assert.equal(result.value.orderPage.total,5);
        assert.equal(result.value.orderPage.revision,'101');assert.deepEqual(result.value.orderPage.stats,{drafts:2,weekly:2});
        const oldCounts=result.firstSnapshot.filter(row=>row.sql.startsWith('SELECT COUNT(*) AS count'));
        if(oldCounts.length)assert.equal(api.safeSqlInteger(oldCounts[0].rows[0].count),6);
      }
    });
  }
  for(const bound of ['', 'revision=100'])await check('search_snapshot_and_revision:'+bound,async()=>{
    if(bound)await assert.rejects(()=>interleaved({stage:'rows',bound,search:true}),error=>error.status===409&&error.currentRevision==='101');
    else{const result=await interleaved({stage:'rows',search:true});assert.equal(result.value.orderPage.total,5);assert.equal(result.value.orderPage.revision,'101');}
  });
  await check('exactly_two_first_page_retries_then_409',async()=>{
    await assert.rejects(()=>interleaved({stage:'stats',always:true}),error=>error.status===409&&error.currentRevision==='103'&&error.contract.fired===3);
  });
  await check('input_params_captured_before_waiting',async()=>{
    const input=params(),wrapped={read:action=>database.read(tx=>{input.set('kind','sim');return action(tx);}),write:()=>assert.fail(),close:async()=>{}};
    const result=await repo(wrapped).listOrdersPage(identity(ACTORS.global),input);assert.equal(result.orderPage.total,6);assert.equal(input.get('kind'),'sim');
  });
  await check('clock_and_expiry_observed_after_waiting_for_snapshot',async()=>{
    const entered=deferred(),release=deferred();
    const holder=other.write(async()=>{entered.resolve();await release.promise;});await entered.promise;
    const pending=page(),rejected=rejects(()=>pending,401);now=BASE_TIME+86400000;release.resolve();await holder;
    await rejected;
  });
  if(fixture.orderSchema){
    // These are distinct target-schema invariants, not parity claims for invalid
    // legacy metadata. The caller must have executed the real schema contract.
    const plan=fixture.orderSchema;
    assert(Object.isFrozen(plan)&&Object.isFrozen(plan.tables));
    assert.equal(plan.version,'postgres-order-schema-v1');assert.equal(plan.schema,applicationSchema);
    assert(plan.tables.includes('order_list_revision'));
    assert.equal(await database.read(tx=>tx.dialect),'postgresql');
    await check('target_schema_revision_bounds_refuse_unsafe_metadata',async()=>{
      const before=await revision();
      for(const value of ['9007199254740991','9007199254740992']){
        await assert.rejects(()=>write(`UPDATE ${a}.order_list_revision SET revision=${value} WHERE id=1`),error=>error.code==='23514');
        assert.equal(await revision(),before);
      }
      try{
        await write(`UPDATE ${a}.order_list_revision SET revision=9007199254740990 WHERE id=1`);
        assert.equal((await page()).orderPage.revision,'9007199254740990');
      }finally{await write(`UPDATE ${a}.order_list_revision SET revision=100 WHERE id=1`);}
    });
    await check('target_schema_preserves_positive_generation_and_restricted_singleton',async()=>{
      const before=await revision();
      for(const [sql,code]of [
        [`UPDATE ${a}.order_list_revision SET revision=0 WHERE id=1`,'23514'],
        [`DELETE FROM ${a}.order_list_revision WHERE id=1`,'42501'],
        [`INSERT INTO ${a}.order_list_revision VALUES(1,100)`,'42501'],
      ]){await assert.rejects(()=>write(sql),error=>error.code===code);assert.equal(await revision(),before);}
    });
  }else{
    await check('list_revision_safe_integer_contract',async()=>{
      await write(`UPDATE ${a}.order_list_revision SET revision=9007199254740991 WHERE id=1`);
      assert.equal((await page()).orderPage.revision,'9007199254740991');
      await write(`UPDATE ${a}.order_list_revision SET revision=9007199254740992 WHERE id=1`);
      await assert.rejects(()=>page(),/outside the application number contract/);
    });
    await check('legacy_revision_missing_or_zero_fallback',async()=>{
      await write(`UPDATE ${a}.order_list_revision SET revision=0 WHERE id=1`);assert.equal((await page()).orderPage.revision,'1');
      await write(`DELETE FROM ${a}.order_list_revision WHERE id=1`);assert.equal((await page()).orderPage.revision,'1');
      await write(`INSERT INTO ${a}.order_list_revision VALUES(1,100)`);
    });
  }
  if(fixture.legacyOracle){
    for(const actor of ['global','regional','a'])for(const filter of ['', 'kind=orders&range=day', 'kind=sim&range=all',
      'kind=all&range=30d&q=stefan&limit=2', 'kind=all&range=all&status=finalized',
      'kind=all&range=all&q=martisor', 'kind=all&range=all&limit=2&cursor='+encodeURIComponent(api.encodeOrderListCursor({createdAt:'2026-11-27T10:00:00Z',id:'a2'}))]){
      await check('original_route_oracle:'+actor+':'+filter,async()=>{
        const p=filter?explicit(filter):params();
        const actual=await repo().listOrdersPage(identity(ACTORS[actor]),p);
        const expected=await fixture.legacyOracle(ACTORS[actor],p,now);
        const {weekKey,...withoutWeek}=actual;assert.equal(weekKey,api.orderWeekKey(new Date(now)));assert.deepEqual(withoutWeek,expected);
      });
    }
  }
  return cases;
}
