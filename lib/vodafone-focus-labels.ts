import {countyLabel} from './portfolio-facets';
import type {Territory} from './distribution-rules';
import type {FocusCategory, FocusRow} from './vodafone-focus';

export const focusTerritoryLabels: Record<Territory, string> = {sud: 'SUD', nord_a: 'Nord A', nord_b: 'Nord B'};
const focusCategoryLabels: Record<FocusCategory, string> = {
  zero3: 'SIM Zero · 3–4,99 EUR',
  zero5: 'SIM Zero · cel puțin 5 EUR',
  credit: 'Credit inițial · cel puțin 3 EUR',
  package: 'Pachet telefon + SIM',
};
export const focusKindLabels: Record<FocusRow['kind'], string> = {
  attributed: 'Realizare TR', possibleStock: 'Stoc posibil',
  otherTR: 'Alt TR', otherChannel: 'Alt canal', unassigned: 'Fără atribuire sigură',
};
export const focusCountyLabel = (county: string) => county === '<UNASSIGNED>' ? 'Județ nealocat' : countyLabel(county);

export const focusCategoryLabel = (category: FocusCategory, territory: Territory) =>
  category === 'credit' && territory !== 'sud' ? 'SIM 5 · Credit inițial' : focusCategoryLabels[category];
