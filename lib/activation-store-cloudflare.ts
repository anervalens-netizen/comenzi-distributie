import type {ActivationQuery} from './activation-distribution';
import type {ActivationReport,ActivationProvider} from './activation-types';
export function readActivations(_month:string,_sites:string[]|null,_provider:ActivationProvider='vodafone',_query?:ActivationQuery):ActivationReport{throw new Error('Activation report requires the Node host');}

export function verifySim(_serial:string,_provider:'vodafone'|'digi'='vodafone'):import('./sim-verification-types').SimVerification{throw new Error('SIM verification requires the Node host');}
