import type {TransferView,TransferLine} from './transfer-types';
export type TransferForm={destinationAgentId:string;lines:TransferLine[];notes:string};
export type TransferWork={version:string;base:TransferView;local:TransferForm;branches?:TransferForm[]};
export const transferForm=(record:TransferView):TransferForm=>({destinationAgentId:record.destination?.agentId||'',lines:record.lines,notes:record.notes});
// Compare only editable wire fields: catalog labels are authoritative on the server.
export const transferBody=(form:TransferForm,revision:number)=>({revision,destinationAgentId:form.destinationAgentId,lines:form.lines.map(line=>({id:line.id,quantity:line.quantity,serials:line.serials})),notes:form.notes.trim()});
export const sameTransferForm=(a:TransferForm,b:TransferForm)=>JSON.stringify(transferBody(a,0))===JSON.stringify(transferBody(b,0));
