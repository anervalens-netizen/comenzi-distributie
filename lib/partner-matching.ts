/** Conservative location evidence. Never use fuzzy strings as an identity key. */
import { normalizeCui, normalizePartnerPointPart } from './partner-identity';
import { canonicalCounty } from './portfolio-facets';
export type MatchPoint={id?:string;cui:string;city:string;county:string;address:string};
export type MatchCategory='exact'|'incomplete'|'near'|'county-conflict'|'distinct';
const words=(s:string)=>normalizePartnerPointPart(s).replace(/[.,;:]/g,' ').replace(/\s+/g,' ').trim();
export const normalizeLocality=(s:string)=>words(s).replace(/^(SAT(?:UL)?|COM(?:UNA)?|MUN(?:ICIPIUL)?|ORAS(?:UL)?)\s+/,'');
export function normalizeAddress(address:string,city:string){
 let s=words(address).replace(/^[\s-]+/g,'').replace(/\bNR(?=\d)/g,'NR ').replace(/\b(?:B-DUL|BDUL|BD|BULEVARDUL|BULEVARD)\b/g,'BULEVARD').replace(/\b(?:STRADA|STR)\s+/g,'');
 const locality=normalizeLocality(city);
 // Remove locality only as a labelled segment or the entire address prefix;
 // a street named after a city must not disappear.
 if(locality){
  for(const prefix of ['SAT ','SATUL ','COMUNA ','MUNICIPIUL ']){
   if(s.startsWith(prefix+locality+' ')||s===prefix+locality)s=s.slice((prefix+locality).length).trim();
   if(s.endsWith(' - '+prefix+locality))s=s.slice(0,-(' - '+prefix+locality).length).trim();
  }
  if(s===locality||s.startsWith(locality+' NR '))s=s.slice(locality.length).trim();
  if(s.endsWith(' - '+locality))s=s.slice(0,-(' - '+locality).length).trim();
  if(s.endsWith(' '+locality)&&/\bNR\s*\d/.test(s))s=s.slice(0,-locality.length).trim();
 }
 s=s.replace(/\s*([/-])\s*/g,'$1').trim();
 const unitAt=s.search(/\b(?:BL|BLOC|AP|APARTAMENT|SC|SCARA|ET|ETAJ)\b/);
 const unit=unitAt<0?'':s.slice(unitAt).replace(/\bBLOC\b/g,'BL').replace(/\bAPARTAMENT\b/g,'AP');
 if(unitAt>=0)s=s.slice(0,unitAt).trim();
 const explicit=s.match(/\b(?:NR|NUMARUL|NUMAR)\s*(\d+(?:[-/]\d+)?\s*[A-Z]?)$/);
 // Only a terminal number is a possible unlabelled house, never a street's internal date.
 let terminal=explicit||s.match(/(?:^|\s)(\d+(?:[-/]\d+)?\s*[A-Z]?)$/);
 // A date in a street name is not a house number.
 if(!explicit&&terminal&&/\b\d+\s+(IANUARIE|FEBRUARIE|MARTIE|APRILIE|MAI|IUNIE|IULIE|AUGUST|SEPTEMBRIE|OCTOMBRIE|NOIEMBRIE|DECEMBRIE)\b/.test(s))terminal=null;
 const house=terminal?terminal[1].replace(/\s/g,''):'';
 const street=(terminal?s.slice(0,terminal.index):s).replace(/\b(?:NR|NUMAR|NUMARUL)\s*$/,'').trim();
 return {street,house,unit};
}
function nearbyStreet(a:string,b:string){
 if(Math.min(a.length,b.length)<5||Math.abs(a.length-b.length)>1)return false;
 let i=0,j=0,edits=0;
 while(i<a.length&&j<b.length){if(a[i]===b[j]){i++;j++;continue;}if(++edits>1)return false;if(a.length>=b.length)i++;if(b.length>=a.length)j++;}
 return edits+(a.length-i)+(b.length-j)<=1;
}
export function rankPartnerCandidates<T extends MatchPoint>(wanted:MatchPoint,points:T[]){
 const city=normalizeLocality(wanted.city),a=normalizeAddress(wanted.address,wanted.city);
 const county=(s:string)=>canonicalCounty(s).id||words(s);
 return points.filter(p=>normalizeCui(p.cui)===normalizeCui(wanted.cui)).map(point=>{
  const b=normalizeAddress(point.address,point.city),otherCity=normalizeLocality(point.city);
  const sameCity=!!city&&city===otherCity,sameStreet=!!a.street&&a.street===b.street,sameHouse=!!a.house&&a.house===b.house;
  let category:MatchCategory='distinct',reason='Altă adresă sau localitate',score=0;
  if(sameCity){
   if(sameStreet&&sameHouse&&a.unit===b.unit){category='exact';reason='Aceeași localitate, stradă și număr';score=100;}
   else if((sameStreet&&(!a.house||!b.house))||(sameHouse&&(!a.street||!b.street))){category='incomplete';reason='Adresă incompletă: verifică strada și numărul';score=80;}
   else if(sameHouse&&!sameStreet&&nearbyStreet(a.street,b.street)){category='near';reason='Același număr, străzi scrise asemănător';score=65;}
   else if(sameStreet&&sameHouse){category='near';reason='Același număr, bloc/apartament diferit';score=70;}
   else if(sameStreet&&/^\d+[A-Z]?$/.test(a.house)&&/^\d+[A-Z]?$/.test(b.house)&&a.house.replace(/[A-Z]$/,'')===b.house.replace(/[A-Z]$/,'')){category='near';reason='Aceeași stradă și număr de bază, litere diferite';score=65;}
   else if(sameStreet&&/^\d+$/.test(a.house)&&/^\d+$/.test(b.house)&&Math.abs(Number(a.house)-Number(b.house))<=2){category='near';reason='Aceeași stradă, numere apropiate';score=60;}
   else if(!a.street||!b.street){category='incomplete';reason='Aceeași localitate, stradă lipsă';score=40;}
   if(category!=='distinct'&&(!county(wanted.county)||!county(point.county)||county(wanted.county)!==county(point.county))){category='county-conflict';reason='Județ diferit sau lipsă: poate fi altă localitate cu același nume';score=50;}
  }else if(!city||!otherCity){category='incomplete';reason='Localitate lipsă: verifică punctul firmei';score=30;}
  return {point,category,reason,score};
 }).sort((a,b)=>b.score-a.score||(a.point.id||'').localeCompare(b.point.id||''));
}
export function choosePartnerCandidate<T extends MatchPoint>(wanted:MatchPoint,points:T[],choice:string){
 const ranked=rankPartnerCandidates(wanted,points),credible=ranked.filter(p=>p.category!=='distinct'),exact=credible.filter(p=>p.category==='exact');
 if(choice&&choice!=='new'){
  const selected=ranked.find(p=>p.point.id===choice);
  if(!selected)throw new Error('Alegerea punctului nu mai este valabilă. Actualizează lista.');
  return selected.point;
 }
 if(exact.length===1&&credible.length===1)return exact[0].point;
 if(credible.length&&(!choice||exact.length>0))throw new Error('Posibil punct duplicat. Alege explicit punctul existent sau o locație diferită/nouă.');
 return undefined;
}
