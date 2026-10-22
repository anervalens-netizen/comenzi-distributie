"""Wholly synthetic activation fixture for store and authenticated HTTP/browser acceptance."""
import sys,json
from pathlib import Path
sys.path.insert(0,'tools')
import activations as a
from activation_report import build_report
from test_activations import row,fixture
root=Path(sys.argv[1]);c=a.connect(root)
rules={'version':1,'revision':'synthetic-1','history':'all','assignments':[{'userId':'north','siteCode':'N','projectId':'vodafone_nord','territoryId':'nord_a','counties':['CV']},{'userId':'south','siteCode':'S','projectId':'vodafone_sud','territoryId':'sud','counties':['AG']},{'userId':'non','siteCode':'X','projectId':'non_exclusiv','territoryId':None,'counties':['TM']}],'products':{'ZERO':'vodafone_0','CREDIT':'vodafone_3'}}
rows=[]
for i,(site,county,handset,code,active,month,point) in enumerate([
 ('N','Covasna','SIM with initial credit >= 3 EUR','CREDIT',True,'202610','A'),
 ('N','ARGES','SIM Zero with Recharge >= 5E','ZERO',True,'202610','A'),
 ('N','TIMIS','SIM with initial credit >= 3 EUR','CREDIT',True,'202610','A'),
 ('N','CV','Other Paid SIMs','CREDIT',True,'202610','B'),
 ('S','AG','SIM with initial credit >= 3 EUR','CREDIT',True,'202610','A'),
 ('S','CV','SIM with initial credit >= 3 EUR','CREDIT',True,'202610','B'),
 ('S','AG','Other Paid SIMs','CREDIT',True,'202610','B'),
 ('S','AG','SIM with initial credit >= 3 EUR','CREDIT',True,'202609','A'),
 ('X','AG','SIM with initial credit >= 3 EUR','CREDIT',True,'202610','A'),
 ('N','','','ZERO',False,'202610','A')]):
 serial=f'{i+1:018d}';rows.append(row(DocumentDetailId=str(i),IMEI=serial+'0',Activat=serial if active else '',DataVDF='20260801',DataActivare=month+'15' if active else '',SiteCode=site,JudetActivare=county,HandSetType=handset,ItemCode=code,CIF='EXAMPLE',CodPunctDeLucru=point))
rows.append(row(DocumentDetailId='synthetic-retail',IMEI='0000000000000000990',Activat='000000000000000099',DataVDF='20260801',DataActivare='20261015',TR='Synthetic retail',SiteCode='STORE',JudetActivare='AG',HandSetType='Other Paid SIMs',ItemCode='CREDIT',CIF='EXAMPLE',CodPunctDeLucru='A'))
a.import_files(c,root,[fixture(root/'input.xlsx',rows)],operator='vodafone')
c.close();build_report(root,rules);(root/'rules.json').write_text(json.dumps(rules))
