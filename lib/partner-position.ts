import type {PortfolioPartner} from './partner-portfolio-types';

type Position = Pick<PortfolioPartner,'latitude'|'positionSource'|'positionQuality'> & Partial<Pick<PortfolioPartner,'positionAccuracy'|'updatedAt'>>;

export function partnerPositionLabel(position:Position) {
  if(position.latitude===null)return 'Poziție necunoscută';
  if(position.positionSource==='manual'){
    if(position.positionQuality==='locality_approximate')return 'Confirmat manual · centrul localității (aproximativ)';
    if(position.positionQuality==='street_approximate')return 'Confirmat manual · pe stradă (aproximativ)';
    if(position.positionQuality==='address_approximate')return 'Confirmat manual · adresă aproximativă';
    return 'Pin confirmat manual';
  }
  if(position.positionSource==='gps')return 'Poziție preluată prin GPS';
  if(position.positionQuality==='locality_approximate')return 'Aproximativ · centrul localității';
  if(position.positionQuality==='street_approximate')return 'Aproximativ · pe stradă';
  if(position.positionQuality==='address_approximate')return 'Aproximativ · adresă potrivită';
  if(position.positionSource==='geocoding')return 'Poziție din adresa completă';
  return 'Poziție cu proveniență necunoscută';
}

export function partnerPositionProvenance(position:Position) {
  const parts=[partnerPositionLabel(position)];
  if(typeof position.positionAccuracy==='number'&&position.positionSource==='gps')parts.push(`precizie raportată ${Math.round(position.positionAccuracy)} m`);
  if(position.updatedAt)parts.push(`actualizată ${new Date(position.updatedAt).toLocaleString('ro-RO',{timeZone:'Europe/Bucharest'})}`);
  return parts.join(' · ');
}

export function positionNeedsConfirmation(position:Pick<Position,'latitude'|'positionSource'|'positionQuality'>) {
  return position.latitude===null||position.positionSource===null||position.positionSource==='geocoding'&&position.positionQuality?.endsWith('_approximate')===true;
}
