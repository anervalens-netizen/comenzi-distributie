import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';

const directory=mkdtempSync(join(tmpdir(),'manager-ai-sandbox-test-'));
try {
  const bundle=await build({
    stdin:{resolveDir:process.cwd(),contents:"export * from './lib/manager-ai-sandbox.ts'; export * from './lib/manager-ai-sandbox-artifacts.ts';"},
    platform:'node',format:'esm',bundle:true,write:false,
    plugins:[{name:'synthetic-sandbox-runner',setup(b){
      b.onResolve({filter:/^\.\/server$/},()=>({path:'server',namespace:'test'}));
      b.onLoad({filter:/.*/,namespace:'test'},()=>({contents:`
        export class AppError extends Error{constructor(status,message){super(message);this.status=status;}}
        export const fail=(status,message)=>{throw new AppError(status,message);};
        export const readLimited=async req=>new Uint8Array(await req.arrayBuffer());
      `}));
    }}],
  });
  const modulePath=join(directory,'sandbox-test.mjs');
  writeFileSync(modulePath,bundle.outputFiles[0].text);
  const {runManagerAiSandbox,managerAiSandboxAvailable,normalizeManagerAiSandboxArtifact}=await import(pathToFileURL(modulePath));
  for(const [extension,separator] of [['csv',','],['tsv','\t']]) {
    const literals=['-1','+3.5','-.75','-1.25e-4','-9223372036854775808'];
    const formulas=['-1+2','+3+5','=1+1','@SUM(1)',' +1+1','-1\n+1'];
    const rows=[['Label','Value'],...[...literals,...formulas].map((value,index)=>['Example '+index,'"'+value+'"'])];
    const result=normalizeManagerAiSandboxArtifact({filename:'synthetic.'+extension,
      mime_type:extension==='csv'?'text/csv':'text/tab-separated-values',kind:'output',
      bytes:new TextEncoder().encode(rows.map(row=>row.join(separator)).join('\n'))});
    assert(result);
    const output=new TextDecoder().decode(result.bytes);
    for(const [index,value] of literals.entries())assert(output.includes('"Example '+index+'"'+separator+value+'\r\n'),value+' must keep its numeric spelling');
    for(const value of formulas)assert(output.includes(separator+'"\''+value+'"\r\n'),value+' must stay literal text');
  }
  const fixture=join(directory,'dataset.sqlite');
  const connection=new DatabaseSync(fixture);
  connection.exec(`
    CREATE TABLE sales_lines(sku TEXT NOT NULL,units INTEGER NOT NULL);
    INSERT INTO sales_lines VALUES('FIXTURE-A',2), ('FIXTURE-A',3), ('FIXTURE-B',1);
  `);
  connection.close();
  const database=readFileSync(fixture);
  const request={language:'sql',code:'SELECT sku,SUM(units) AS units FROM sales_lines GROUP BY sku ORDER BY sku',
    database,signal:new AbortController().signal};
  delete process.env.MOBIUP_MANAGER_AI_SANDBOX_ENABLED;
  assert.equal(managerAiSandboxAvailable(),false);
  await assert.rejects(runManagerAiSandbox(request),{status:503});

  process.env.MOBIUP_MANAGER_AI_SANDBOX_ENABLED='1';
  if(!managerAiSandboxAvailable()) {
    assert.notEqual(process.env.MOBIUP_MANAGER_AI_SANDBOX_TEST_REQUIRED,'1','The configured isolated worker must be available.');
    console.log('PASS: disabled sandbox fails closed. Native exercise requires the provisioned HP analysis runtime.');
  } else {
    const sql=await runManagerAiSandbox(request);
    assert.equal(sql.exitCode,0);
    assert.deepEqual(sql.rows,{columns:['sku','units'],rows:[['FIXTURE-A',5],['FIXTURE-B',1]],truncated:false,exportTruncated:false,exportedRows:2});
    assert.deepEqual(sql.artifacts.map(file=>file.filename),['rezultat-sql.csv']);
    const correction=await runManagerAiSandbox({...request,code:'SELECT -1 AS units'});
    assert.equal(correction.exitCode,0);
    assert.equal(correction.artifacts.length,1);
    const write=await runManagerAiSandbox({...request,code:'CREATE TABLE synthetic_write (id INTEGER)'});
    assert.notEqual(write.exitCode,0);
    assert.deepEqual(write.artifacts,[]);
    assert.deepEqual(readFileSync(fixture),database);
    await assert.rejects(runManagerAiSandbox({...request,database:undefined}),{status:400});
    const preview=await runManagerAiSandbox({...request,code:`WITH RECURSIVE counts(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM counts WHERE n<100) SELECT n FROM counts`});
    assert.equal(preview.rows.rows.length,60);
    assert.equal(preview.rows.truncated,true);
    assert.equal(preview.rows.exportTruncated,false);
    const clipped=await runManagerAiSandbox({...request,code:"SELECT printf('%03000d',1) AS output"});
    assert.equal(clipped.rows.exportTruncated,true);
    assert.equal(clipped.rows.exportedRows,1);

    const reusedExport=await runManagerAiSandbox({
      ...request,language:'python',
      inputs:[{filename:'large-report.txt',mime_type:'text/plain',kind:'input',bytes:Buffer.alloc(1280*1024,65)}],
      code:'from pathlib import Path\nprint(next(Path("/input/files").iterdir()).stat().st_size)',
    });
    assert.equal(reusedExport.exitCode,0);
    assert.equal(reusedExport.stdout.trim(),String(1280*1024),'A retained export can exceed the original upload size limit.');


    process.env.MOBIUP_SANDBOX_TEST_SENTINEL='synthetic-value';
    const python=await runManagerAiSandbox({
      ...request,language:'python',inputs:[{filename:'sample.txt',mime_type:'text/plain',kind:'input',bytes:Buffer.from('fixture only')},
        {...correction.artifacts[0],kind:'input'}],
      code:`
import binascii
import os
from pathlib import Path
import socket
import sqlite3
import struct
import threading
import zlib
import pandas as pd
from openpyxl import Workbook

assert os.getenv("MOBIUP_SANDBOX_TEST_SENTINEL") is None
assert not Path("/home").exists()
assert not Path("/etc/passwd").exists()
assert not os.access("/proc/1/fd/1", os.R_OK)
assert not os.access("/input/data.sqlite", os.W_OK)
assert Path("/input/files/1-sample.txt").read_text() == "fixture only"
assert pd.read_csv("/input/files/2-rezultat-sql.csv")["units"].sum() == -1
try:
    socket.socket()
except PermissionError:
    pass
else:
    raise AssertionError("Sockets must be unavailable")
thread = threading.Thread(target=lambda: None)
try:
    thread.start()
except RuntimeError:
    pass
else:
    thread.join()
    raise AssertionError("Workload cannot add worker threads")

with sqlite3.connect("file:/input/data.sqlite?mode=ro", uri=True) as db:
    data = pd.read_sql_query("SELECT SUM(units) AS total FROM sales_lines", db)
total = int(data["total"].iloc[0])
print(total)
workbook = Workbook()
sheet = workbook.active
sheet.append(["Units"])
sheet.append([total])
workbook.save("/output/analiza.xlsx")
Path("/output/analiza.txt").write_text("Sursa demonstrativă")
Path("/output/copie.txt").symlink_to("/output/analiza.txt")
Path("/output/ignorat.html").write_text("<p>Nu se exportă</p>")

def chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", binascii.crc32(kind + data))
width, height = 20, 10
pixels = b"".join(b"\\x00" + (b"\\x12\\x72\\xb8" * total + b"\\xff\\xff\\xff" * (width - total)) for _ in range(height))
png = b"\\x89PNG\\r\\n\\x1a\\n"
png += chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
png += chunk(b"IDAT", zlib.compress(pixels)) + chunk(b"IEND", b"")
Path("/output/grafic.png").write_bytes(png)
      `,
    });
    assert.equal(python.exitCode,0,python.stderr);
    assert.equal(python.stdout.trim(),'6');
    assert.deepEqual(python.artifacts.map(file=>file.filename),['analiza.txt','analiza.xlsx','grafic.png']);
    assert.equal(python.skippedArtifacts,2);
    assert.equal(python.artifacts[2].mime_type,'image/png');
    assert.ok(python.artifacts[1].bytes.byteLength>0);

    const abort=new AbortController();
    const delayed=runManagerAiSandbox({...request,language:'python',code:'import time; time.sleep(8)',signal:abort.signal});
    await assert.rejects(runManagerAiSandbox(request),{status:429});
    const began=Date.now();
    const alarm=setTimeout(()=>abort.abort(),250);
    try{await assert.rejects(delayed,{name:'AbortError'});}finally{clearTimeout(alarm);}
    assert.ok(Date.now()-began<3000,'Abort should terminate the isolated process promptly.');
    const next=await runManagerAiSandbox(request);
    assert.equal(next.exitCode,0);
    console.log('PASS: live isolated SQL/Python, scoped read-only inputs, pandas/XLSX/PNG, bounded formats, network denial, quota and cancellation.');
  }
} finally {
  rmSync(directory,{recursive:true,force:true});
}
