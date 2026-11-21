import {projectIds,type DistributionRules} from './distribution-rules';
import {salesLocationKey,salesSiteKey} from './sales-location';
import type {VodafoneBonusScope} from './vodafone-bonus-types';

export function bonusProjectSites(scope: VodafoneBonusScope, rules: DistributionRules, projects: ReadonlySet<string>) {
  // The full historical register also contains sites that no longer have a project assignment.
  if (projectIds.every(project=>projects.has(project))) return scope;
  const allowed=scope===null ? null : new Set(scope);
  return rules.assignments.filter(assignment=>projects.has(assignment.projectId))
    .map(assignment=>salesSiteKey(assignment.siteCode)).filter(site=>allowed===null || allowed.has(site)).sort();
}

// Aliases must consume the whole normalized label. "Generic Example SRL" and
// other legal names with an ordinary word match remain eligible.
const genericLabel = /^(?:NEIDENTIFICAT|DEFAULT|IMPLICIT)?(?:(?:CLIENT|CLIENTUL|PARTENERCLIENT|PARTNERCLIENT|PARTENER|PARTNER)GEN(?:ERICI?)?|GEN(?:ERIC)?(?:CLIENT|PARTENER|PARTNER)|GENERIC)(?:NEIDENTIFICAT|DEFAULT|IMPLICIT|TEMPORAR)?(?:[0-9]{1,8})?$/;
export function isVodafoneGenericPartner(...values: string[]) {
  return values.some(value => genericLabel.test(salesLocationKey(value).replaceAll(' ', '')));
}

export function vodafoneDocumentKind(values: readonly string[], purpose: 'sale' | 'payment' = 'sale', partner = '') {
  const normalized = values.map(salesLocationKey);
  if ([...normalized,salesLocationKey(partner)].some(value => /^(?:BON(?:URI)? (?:DE )?CONSUM|REGL(?:ARE|ARI)? (?:DE )?GESTIUNE|CORECTIE (?:DE )?STOC|AJUSTARE (?:DE )?(?:STOC|GESTIUNE)|TRANSFER (?:DE )?(?:STOC|GESTIUNE))(?: |$)/.test(value))) {
    return 'excluded';
  }
  if (normalized.some(value => /^(?:FACTUR(?:A|I)(?: FISCALA)?|INVOICE|COMMERCIAL INVOICE)(?: |$)/.test(value))) {
    return 'commercial';
  }
  if (purpose === 'sale' && normalized.some(value => /^AVIZ (?:DE )?INSOTIRE(?: A MARFII)?(?: |$)/.test(value))) return 'commercial';
  return 'unknown';
}

export function vodafoneSim0Bonus(activations: number) {
  if (activations >= 10) return Math.floor(activations / 10) * 5;
  if (activations >= 5) return 2;
  return activations >= 3 ? 1 : 0;
}
