import {validAnafCui} from './anaf-types';
import {isVodafoneGenericPartner} from './vodafone-bonus-rules';
import {projectVodafoneSim0Rows,type VodafoneBonusRead} from './vodafone-bonus-node';
import type {BonusActivation} from './vodafone-bonus-ledger';
import type {VodafoneBonusScope} from './vodafone-bonus-types';

export type VodafoneSim0RankingRead = VodafoneBonusRead & {kind:'sim0-clients';fromMonth:string;toMonth:string};
type Coverage = {month:string;sourceThrough:string|null;reported:boolean};
const excludedReasons={
  'excluded':'client generic sau operațiune exclusă în surse',
  'conflict':'surse contradictorii',
  'client-missing':'client neidentificat',
  'point-unknown':'punct neidentificat',
  'unmatched':'vânzare fără corespondență',
  'invalid-cui':'CUI nevalid',
  'no-company':'firmă absentă din catalogul CRM',
  'generic':'denumire generică',
  'return':'retur',
  'mixed':'document mixt',
} as const;
export type VodafoneSim0Ranking = {
  revision:string;
  rows:{month:string;cui:string;partner:string;franchise:string;activations:number;confirmedActivations:number}[];
  coverage:(Coverage & {excludedActivations:number;exclusions:Record<string,number>})[];
};

/** Apply the site boundary before a group or an exclusion count can reach the caller. */
export function groupVodafoneSim0Clients(source:{
  activation:readonly BonusActivation[]; companies:ReadonlyMap<string,string>; coverage:readonly Coverage[]; revision:string;
}, scope:VodafoneBonusScope):VodafoneSim0Ranking {
  const sites=scope===null?null:new Set(scope);
  const coverage=new Map(source.coverage.map(row=>[row.month,{...row,excludedActivations:0,exclusions:{} as Record<string,number>}]));
  const points=new Map<string,VodafoneSim0Ranking['rows'][number]>();
  for (const fact of source.activation) {
    if (sites && !sites.has(fact.site)) continue;
    const month=coverage.get(fact.month);
    if (!month) continue;
    const name=source.companies.get(fact.cui)?.trim();
    const reason=fact.reason!=='commercial' && fact.reason!=='document-unknown' ? fact.reason :
      !fact.pointCode ? 'point-unknown' : !validAnafCui(fact.cui) ? 'invalid-cui' :
      !name ? 'no-company' : isVodafoneGenericPartner(name,fact.partner) ? 'generic' : null;
    if (reason || !name || !fact.pointCode) {
      const category=excludedReasons[reason??'point-unknown'];
      month.exclusions[category]=(month.exclusions[category]??0)+1;
      month.excludedActivations++;
      continue;
    }
    const key=JSON.stringify([fact.month,fact.cui,fact.pointCode]);
    let row=points.get(key);
    if (!row) {
      row={month:fact.month,cui:fact.cui,partner:name,franchise:fact.pointCode,activations:0,confirmedActivations:0};
      points.set(key,row);
    }
    row.activations++;
    if (fact.reason==='commercial') row.confirmedActivations++;
  }
  return {revision:source.revision,rows:[...points.values()],coverage:[...coverage.values()]};
}

// Keep only the last scoped aggregate. The source verifies all revisions before every reuse.
let cached:{key:string;value:VodafoneSim0Ranking}|undefined;
export function readVodafoneSim0Ranking(input:VodafoneSim0RankingRead) {
  cached=projectVodafoneSim0Rows(input,input.fromMonth,input.toMonth,input.scope,
    source=>groupVodafoneSim0Clients(source,input.scope),cached);
  return cached.value;
}
