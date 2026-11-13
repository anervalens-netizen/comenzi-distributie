export type AnafCompany = {
 cui: string; name: string; fiscalAddress: string; registrationNumber: string;
 registrationState: string; vatRegistered: boolean | null; inactive: boolean | null;
};
export type AnafResult = {
 source: 'ANAF'; cui: string; queriedFor: string; checkedAt: string | null;
 status: 'found' | 'not_found' | 'invalid' | 'unavailable';
 message: string; company?: AnafCompany; cached?: boolean;
};
export function normalizeAnafCui(raw: string): string {
 return raw.trim().replace(/^RO\s*/i, '');
}
export function validAnafCui(raw: string): boolean {
 const cui=normalizeAnafCui(raw);
 if(!/^[1-9]\d{1,9}$/.test(cui))return false;
 const digits=cui.slice(0,-1).padStart(9,'0');
 const sum=digits.split('').reduce((total,digit,index)=>total+Number(digit)*Number('753217532'[index]),0);
 return (sum*10%11)%10===Number(cui.at(-1));
}
