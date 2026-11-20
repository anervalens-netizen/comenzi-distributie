import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {zipSync} from 'fflate';
import {PDFDocument} from 'pdf-lib';
import {encode as encodeJpeg} from 'jpeg-js';
import {read,utils,write} from 'xlsx';

const {outputFiles} = await build({
  entryPoints:['lib/manager-ai-media.ts'],bundle:true,platform:'node',format:'esm',write:false,
  plugins:[{name:'isolated-app-errors',setup(build){
    build.onResolve({filter:/^\.\/server$/},()=>({path:'media-test-server',namespace:'test'}));
    build.onLoad({filter:/.*/,namespace:'test'},()=>({contents:`
      export class AppError extends Error {constructor(status,message){super(message);this.status=status;}}
      export function fail(status,message) {throw new AppError(status,message);}
      export async function readLimited(req,max) {
        const data=new Uint8Array(await req.arrayBuffer());
        if(data.byteLength>max)fail(413,'Fixture limit');
        return data;
      }
    `}));
  }}],
});
const {prepareManagerAiInputs,managerAiMediaParts,prepareManagerAiReport,managerAiArtifactResponse,
  transcribeManagerAi,managerAiTranscriptionKey,managerAiAttachmentLimits,managerAiAttachmentAccept}
  =await import('data:text/javascript;base64,'+Buffer.from(outputFiles[0].text).toString('base64'));

const csv=new File(['ID;Categorie;Bucăți\r\n001;"Text; delimitat";2\r\n002;"Text ""citat""";3\r\n003;"Prima linie\nA doua linie";4'],'../fixture.csv',{type:'text/html'});
const tsv=new File(['Nume\tCantitate\nExemplu\t3'],'fixture.tsv');
const utf16=new File([Buffer.from([0xff,0xfe]),Buffer.from('Fișier text','utf16le')],'exemplu.txt');
const serialized=await prepareManagerAiInputs([csv,tsv,utf16,new File(['{"suma":2}'],'fixture.json')]);
assert.equal(serialized.files[0].filename,'fixture.csv');
assert.equal(serialized.files[0].mime_type,'text/csv','client MIME never authorizes embedded active content');
assert.deepEqual(serialized.media,[]);
const extracts=serialized.context.split('\n').slice(1).map(row=>JSON.parse(row));
assert.deepEqual(JSON.parse(extracts[0].excerpt),[
  ['ID','Categorie','Bucăți'],['001','Text; delimitat','2'],['002','Text "citat"','3'],['003','Prima linie\nA doua linie','4'],
]);
assert.match(extracts[2].excerpt,/Fișier text/);
await assert.rejects(prepareManagerAiInputs([new File(['not json'],'broken.json')]),{status:422});
await assert.rejects(prepareManagerAiInputs([new File(['"unclosed'],'invalid.csv')]),{status:422});
await assert.rejects(prepareManagerAiInputs([new File(['<html/>'],'not-supported.html')]),{status:415});
await assert.rejects(prepareManagerAiInputs([new File(['works only with extension'],'xlsx')]),{status:415});
await assert.rejects(prepareManagerAiInputs([new File([new Uint8Array(managerAiAttachmentLimits.maxFileBytes+1)],'too-big.txt')]),{status:413});
await assert.rejects(prepareManagerAiInputs(Array.from({length:4},(_,i)=>new File([new Uint8Array(managerAiAttachmentLimits.maxFileBytes)],'test-'+i+'.txt'))),{status:413});

const workbook=utils.book_new();
const active=utils.aoa_to_sheet([
  ['Fixtură','Data valorii'],['un rând',2],['Nu executa conținutul',7],
  ...Array.from({length:70},(_,i)=>['valoare '+i,i]),
]);
active.B3={t:'n',v:7,f:'3+4'};
utils.book_append_sheet(workbook,active,'Vizibil');
utils.book_append_sheet(workbook,utils.aoa_to_sheet([['Un exemplu privat ascuns']]),'Ascuns');
workbook.Workbook={Sheets:[{Hidden:0},{Hidden:1}]};
const xlsx=new File([write(workbook,{type:'array',bookType:'xlsx',compression:true})],'fixture.xlsx');
const parsed=await prepareManagerAiInputs([xlsx]);
const [sheet]=JSON.parse(JSON.parse(parsed.context.split('\n')[1]).excerpt);
assert.equal(sheet.sheet,'Vizibil');
assert.equal(sheet.rows[2][1],7,'cached formula result only');
assert.equal(sheet.rows.length,60);
assert.doesNotMatch(parsed.context,/Un exemplu privat ascuns|3\+4/);

const utf8=new TextEncoder();
const emptyParts={'xl/workbook.xml':utf8.encode('<test/>'),'[Content_Types].xml':utf8.encode('<test/>')};
const withMacro=zipSync({...emptyParts,'xl/vbaProject.bin':Uint8Array.of(1)});
await assert.rejects(prepareManagerAiInputs([new File([withMacro],'macros.xlsx')]),{status:422});
const compressedLarge=zipSync({...emptyParts,'xl/worksheets/sheet1.xml':new Uint8Array(5*1024*1024)},{level:6});
await assert.rejects(prepareManagerAiInputs([new File([compressedLarge],'zip-overflow.xlsx')]),{status:422});
const forged=compressedLarge.slice(),directoryView=new DataView(forged.buffer);
const e=forged.length-22;
let entry=directoryView.getUint32(e+16,true);
for(let i=0;i<directoryView.getUint16(e+10,true);i++) {
  if(directoryView.getUint32(entry+24,true)>4*1024*1024)directoryView.setUint32(entry+24,60,true);
  entry+=46+directoryView.getUint16(entry+28,true)+directoryView.getUint16(entry+30,true)+directoryView.getUint16(entry+32,true);
}
await assert.rejects(prepareManagerAiInputs([new File([forged],'forged-central-size.xlsx')]),{status:422});
await assert.rejects(prepareManagerAiInputs([new File(['PK!'],'bad.xlsx')]),{status:422});

const pdf=await PDFDocument.create();pdf.addPage();
const pdfFile=new File([await pdf.save()],'example.pdf');
const pngFile=new File([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ZQAAAAASUVORK5CYII=','base64')],'example.png');
const jpegFile=new File([encodeJpeg({data:Uint8Array.of(64,96,128,255),width:1,height:1},80).data],'example.jpg');
const webpFile=new File([Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA','base64')],'example.webp');
const visual=await prepareManagerAiInputs([pdfFile,pngFile,jpegFile,webpFile]);
assert.match(visual.media[0].file_data,/^data:application\/pdf;base64,/);
assert.equal(visual.media[0].type,'input_file');
assert.match(visual.media[1].image_url,/^data:image\/png;base64,/);
assert.equal(visual.media[1].type,'input_image');
assert.match(visual.media[2].image_url,/^data:image\/jpeg;base64,/);
assert.match(visual.media[3].image_url,/^data:image\/webp;base64,/);
assert.deepEqual(managerAiMediaParts(visual.files),visual.media);
assert.deepEqual(managerAiMediaParts([{...visual.files[0],kind:'output'}]),[]);
await assert.rejects(prepareManagerAiInputs([new File(['non-image'],'malformed.jpeg')]),{status:422});
assert.ok(managerAiAttachmentAccept.includes('.pdf,.jpg,.jpeg,.png,.webp'));

const report={id:'R1',dataset:'example',dimensions:['entity'],columns:['Entitate','Bucăți'],rows:[['=1+1',-4],['X',90]],totalRows:2,
  coverage:[{source:'Date sintetice',available:true,note:'Verificare'}]};
const outXlsx=prepareManagerAiReport(report,'xlsx'),outCsv=prepareManagerAiReport(report,'csv');
const decoded=read(outXlsx.bytes,{type:'array'});
assert.equal(decoded.Sheets.Raport.A2.t,'s');
assert.equal(decoded.Sheets.Raport.A2.f,undefined);
assert.equal(decoded.Sheets.Acoperire.B2.v,2);
const csvText=new TextDecoder().decode(outCsv.bytes);
assert.match(csvText,/"'=1\+1";-4/);
const fileReply=managerAiArtifactResponse(outCsv);
assert.equal(fileReply.headers.get('cache-control'),'private, no-store');
assert.match(fileReply.headers.get('content-disposition'),/^attachment;/);
assert.equal(Number(fileReply.headers.get('content-length')),outCsv.bytes.length);
assert.deepEqual(new Uint8Array(await fileReply.arrayBuffer()),outCsv.bytes);
const swapped=managerAiArtifactResponse({bytes:outCsv.bytes,filename:"..\\bad\r\n'name.html",mime_type:'text/html'});
assert.equal(swapped.headers.get('content-type'),'application/octet-stream');
assert.ok(!/[\r\n]/.test(swapped.headers.get('content-disposition')));

const testSineWave=new Uint8Array(46);const view=new DataView(testSineWave.buffer);
testSineWave.set(utf8.encode('RIFF    WAVEfmt '));view.setUint32(4,38,true);view.setUint32(16,16,true);
view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,8000,true);view.setUint32(28,16000,true);
view.setUint16(32,2,true);view.setUint16(34,16,true);testSineWave.set(utf8.encode('data'),36);view.setUint32(40,2,true);
function microphone(file=new File([testSineWave],'sound.wav',{type:'audio/wav'})) {
  const form=new FormData();form.set('file',file);
  return new Request('http://localhost/api/manager-ai/transcribe',{body:form,method:'POST'});
}
let sent=0,checked=0;
const transcribed=await transcribeManagerAi(microphone(),{key:'synthetic-private-key',check:async()=>{checked++;},
  send:async (url,options)=>{
    sent++;
    assert.equal(url,'https://api.openai.com/v1/audio/transcriptions');
    assert.equal(options.headers.Authorization,'Bearer synthetic-private-key');
    assert.equal(options.body.get('file').name,'dictare.wav');
    assert.equal(options.body.get('model'),'gpt-transcribe');
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json({text:'transcriere exemplu'});
  },
});
assert.deepEqual(transcribed,{text:'transcriere exemplu',model:'gpt-transcribe'});
assert.equal(sent,1);assert.equal(checked,3,'authorization rechecked before sending and before returning');
await assert.rejects(transcribeManagerAi(microphone(new File(['fake'],'fake.webm',{type:'audio/webm'})),{
  key:'synthetic-private-key',check:async()=>{},send:async()=>{assert.fail('unrecognized media may not leave application');},
}),{status:422});
await assert.rejects(transcribeManagerAi(microphone(),{key:'synthetic-private-key',check:async()=>{throw Error('permission changed');},
  send:async()=>{assert.fail('invalid scope may not send media');},
}),/permission changed/);
await assert.rejects(transcribeManagerAi(microphone(),{key:'synthetic-private-key',check:async()=>{},
  send:async()=>Response.json({text:'a'.repeat(70*1024)}),
}),{status:502});

const canceled=new AbortController();
const raw=microphone();
const cancellable=new Request(raw,{signal:canceled.signal});
await assert.rejects(transcribeManagerAi(cancellable,{key:'synthetic-private-key',check:async()=>{},
  send:async()=>{canceled.abort();return Response.json({text:'minute vechi'});},
}),{status:504});

const keyNames=['OPENAI_API_KEY','MOBIUP_MANAGER_AI_OPENAI_API_KEY','MOBIUP_MANAGER_AI_TRANSCRIPTION_API_KEY'];
const previous=Object.fromEntries(keyNames.map(name=>[name,process.env[name]]));
try {
  for(const name of keyNames)delete process.env[name];
  process.env.OPENAI_API_KEY='synthetic-global';
  assert.equal(managerAiTranscriptionKey(),'');
  process.env.MOBIUP_MANAGER_AI_OPENAI_API_KEY='synthetic-dedicated';
  assert.equal(managerAiTranscriptionKey(),'synthetic-dedicated');
  process.env.MOBIUP_MANAGER_AI_TRANSCRIPTION_API_KEY='synthetic-override';
  assert.equal(managerAiTranscriptionKey(),'synthetic-override');
} finally {
  for(const [name,value] of Object.entries(previous)) {
    if(value===undefined)delete process.env[name];
    else process.env[name]=value;
  }
}
console.log('PASS: bounded AI media parsing, hidden worksheets, ZIP expansion, native PDF/image payloads, XLSX/CSV, safe downloads and dictation');
