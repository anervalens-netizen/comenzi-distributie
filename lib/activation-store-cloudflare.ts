import type {ActivationQuery} from './activation-distribution';
import type {ActivationReport,ActivationProvider} from './activation-types';
export function readActivations(_month:string,_sites:string[]|null,_provider:ActivationProvider='vodafone',_query?:ActivationQuery):ActivationReport{throw new Error('Activation report requires the Node host');}
