import {execFileSync} from 'node:child_process';
export function prepareDigiFixture(folder){
 execFileSync('python3',['-c',`
import sys
from pathlib import Path
sys.path.insert(0,'tools')
import activations as a
from test_activations import fixture,digi_row
root=Path(sys.argv[1]);root.mkdir(parents=True,exist_ok=True)
def row(n,**kwargs):return digi_row(Canal=kwargs.pop('Canal','MobiUp'),IMEI=f'{n:019d}',Activat='',DataDigi='',Data=kwargs.pop('Data','2026-05-01'),**kwargs)
rows=[row(10),row(20,Canal='MobiCell',Magazin='Example Store'),row(30,Canal='MobiUpInv'),
 row(40),row(40,Data='2026-05-02',Cantitate='-1'),row(40,Data='2026-05-03'),
 row(50),row(50,Data='2026-05-02',Cantitate='-1'),
 row(60),row(60),row(70),row(70,Cantitate='-1'),
 row(80),row(80,Data='2026-05-02',Cantitate='-1'),row(80,Data='2026-05-03',Canal='MobiCell',Magazin='Example Store'),
 row(90,Canal='MobiUpInv',Cantitate='-1'),row(90),
 row(100),row(100,Data='2026-05-02',Cantitate='-1',**{'Denumire Client':'Different fictional customer'}),
 row(110,Data=''),row(120,Cantitate='0')]
f=fixture(root/'fixture.xlsx',rows,headers=a.DIGI_HEADERS,header_row=1)
c=a.connect(root/'digi')
try:a.import_files(c,root/'digi',[f],operator='digi',site_aliases={('MobiUp','TR Example'):'EXAMPLE'})
finally:c.close()
`,folder]);
}
