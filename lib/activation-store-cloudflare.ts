import type {ActivationQuery} from './activation-distribution';
import type {ActivationReport,ActivationProvider} from './activation-types';
export function readActivations(_month:string,_sites:string[]|null,_provider:ActivationProvider='vodafone',_query?:ActivationQuery):ActivationReport{throw new Error('Activation report requires the Node host');}

export function verifySim(_serial:string,_provider:'vodafone'|'digi'='vodafone'):import('./sim-verification-types').SimVerification{throw new Error('SIM verification requires the Node host');}

export async function readVodafoneFocus(_month:string,_sites:string[]|null,_query:ActivationQuery,_earlyTotals?:boolean):Promise<ActivationReport>{throw new Error('Focus report requires the Node host');}

export async function readVodafoneBonusAsync(_input:import('./vodafone-bonus-node').VodafoneBonusRead):Promise<import('./vodafone-bonus-types').VodafoneBonusReport>{throw new Error('Vodafone bonus report requires the Node host');}

export async function readDigiOverview(_month:string,_sites:string[]|null,_query?:ActivationQuery):Promise<ActivationReport>{throw new Error('Digi report requires the Node host');}
export async function readCombinedActivationPartners(_input:import('./activation-portfolio').CombinedPartnerRead,_page:number):Promise<import('./activation-types').CombinedActivationPartners>{throw new Error('Activation report requires the Node host');}
