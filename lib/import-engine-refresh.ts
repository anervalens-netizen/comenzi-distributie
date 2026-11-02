import {buildActivitySnapshot} from './partner-activity-snapshot';
import {refreshActivitySnapshotMonth} from './partner-activity-incremental';
let raw='';for await(const chunk of process.stdin){raw+=chunk;if(raw.length>1024*1024)throw Error('Input too large');}
const input=JSON.parse(raw),directory=process.env.MOBIUP_DATA_DIR;
if(!directory)throw Error('Missing data directory');
const result=input.result;
let reason:string|undefined;
const incremental=!!result?.month&&refreshActivitySnapshotMonth(directory,result.month,undefined,result.previousSourceDigest,result.previousLogicalDigest,result.sourceLogicalDigest,value=>{reason=value;});
if(!incremental)buildActivitySnapshot(directory);
process.stdout.write(JSON.stringify({mode:incremental?'incremental':'full',...(reason?{reason}:{})})+'\n');
