"""Synthetic SIM baseline and crossing-month source for the integration test."""
import json,sqlite3,sys,zipfile
from pathlib import Path
from contextlib import closing
from test_activations import fixture,row,digi_row
from activation_job import run_job
from test_client_sales_history import fixture as history_fixture,row as history_row
import client_sales_history as history
import activations
root=Path(sys.argv[1]);network=root/'activations';network.mkdir(parents=True)
rules={'version':1,'revision':'synthetic','history':'all','assignments':[],'products':{}}
with closing(sqlite3.connect(root/'mobiup.sqlite')) as db:
 db.execute("INSERT INTO settings(key,value) VALUES('distribution-rules-v1',?)",(json.dumps(rules),));db.commit()
baseline=fixture(root/'baseline.xlsx',[row()]);run_job(network,[{'files':[str(baseline)],'operator':'vodafone'}],rules)
fixture(root/'sim.xlsx',[row(DataVDF='20260131',DocumentDetailId='S1',IMEI='0000000000000000020',Activat='000000000000000002'),row(DataVDF='20260201',DocumentDetailId='S2',IMEI='0000000000000000030',Activat='000000000000000003',Qtty='-1')])
digi=network/'digi';digi.mkdir()
baseline_digi=fixture(root/'baseline-digi.xlsx',[digi_row()],headers=activations.DIGI_HEADERS,header_row=1)
run_job(digi,[{'files':[str(baseline_digi)],'operator':'digi','site_aliases':{('ExampleCo','TR Example'):'SITE-A'}}],rules)
fixture(root/'sim-digi.xlsx',[digi_row(Data='2026-01-10',IMEI='0000000000000000020',Activat='0000000000000000020')],headers=activations.DIGI_HEADERS,header_row=1)
for provider,headers,item,sheet in [
 ('vodafone',['SerieText','DATE_OF_ACTIVATION','COUNTY_OF_ACTIVATION','Paid SIM Category'],{'SerieText':'000000000000000004','DATE_OF_ACTIVATION':'2026-01-10','COUNTY_OF_ACTIVATION':'TEST','Paid SIM Category':'-'},'Detailed SIM'),
 ('digi',['Distribuitor','Seria SIM (iccid)','Data activare'],{'Distribuitor':'ExampleCo','Seria SIM (iccid)':'0000000000000000040','Data activare':'2026-01-10'},'activari')]:
 path=fixture(root/('operator-'+provider+'.xlsx'),[item],headers=headers,header_row=1)
 with zipfile.ZipFile(path) as z:parts={name:(z.read(name).replace(b'name="SIM"',('name="'+sheet+'"').encode()) if name=='xl/workbook.xml' else z.read(name)) for name in z.namelist()}
 with zipfile.ZipFile(path,'w') as z:
  for name,value in parts.items():z.writestr(name,value)
folder=root/'client-history';folder.mkdir();partners=root/'partners.json';master=root/'master.json'
partners.write_text(json.dumps({'partners':[{'id':'p1','cui':'123','county':'County','city':'City','address':'Street 1','historyFranchises':['F001']}]}))
master.write_text(json.dumps([{'CIF':'123','PartnerCode':'123','Cod_Franciza':'F001','Judet':'County','Oras':'City','Street':'Street 1'}]))
annual=root/'annual.xlsx';history_fixture(annual,[history_row(Data='01.01.2024'),history_row(Data='01.02.2024')])
c=history.connect(folder/'client-sales-history.sqlite')
try:history.import_file(c,annual,partners,master)
finally:c.close()
history_fixture(root/'history.xlsx',[history_row(Data='01.02.2024'),history_row(Data='02.02.2024')],'2024-02-01','2024-02-29')
