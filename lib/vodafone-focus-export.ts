import {utils, write} from 'xlsx';
import {focusCategoryLabel,focusCountyLabel,focusKindLabels,focusTerritoryLabels} from './vodafone-focus-labels';
import type {FocusReport} from './vodafone-focus';

export function vodafoneFocusWorkbook(report: FocusReport): string {
  const workbook = utils.book_new();
  const sheet = (name: string, rows: (string | number | null)[][], widths: number[]) => {
    const data = utils.aoa_to_sheet(rows);
    data['!cols'] = widths.map(wch => ({wch}));
    utils.book_append_sheet(workbook, data, name);
  };
  const {regional, territory} = report;
  const name = focusTerritoryLabels[territory];
  const realization = 'Realizare TR ' + name;
  sheet('Focus ' + name, [
    ['Indicator', 'Activări'],
    ...(regional ? [
      ['Total regional Focus ' + name, regional.total],
      ['Alte TR', regional.otherTR],
      ['Alte canale', regional.otherChannels],
      ['Fără atribuire sigură', regional.unassigned],
      ['Județ nealocat · inclus în regional', regional.unassignedCounty],
      ['Date de verificat · excluse din regional', regional.sourceConflicts],
    ] as [string, number][] : []),
    [realization, report.attributed],
    ['Posibile activări din stoc', report.possibleStock],
    ['Stocul posibil este inclus în totalul regional, dacă este afișat.'],
  ], [60, 14]);
  sheet('Pe TR', [
    ['Cod TR', 'Gestiune', realization, 'Posibile activări din stoc'],
    ...report.sites.map(row => [row.site, row.label, row.attributed, row.possibleStock]),
  ], [16, 42, 18, 26]);
  sheet('Istoric lunar', [
    ['Lună', 'Acoperire', 'Raport până la', ...(regional ? ['Total regional'] : []), realization, 'Stoc posibil'],
    ...report.months.map(row => [row.month, row.complete ? 'Completă' : row.coveredThrough ? 'Parțială' : 'Fără sursă',
      row.coveredThrough, ...(regional ? [row.coveredThrough ? row.regional?.total ?? null : null] : []),
      row.coveredThrough ? row.attributed : null, row.coveredThrough ? row.possibleStock : null]),
  ], [14, 17, 18, 20, 18, 18]);
  if (report.detail) {
    const serials = report.detail.rows.some(row => row.serial !== undefined);
    sheet('Detaliu activări', [
      ['Data activării', 'Județ', 'Categorie', 'Rezultat', 'TR', ...(serials ? ['ICCID'] : []),
        'CIF', 'Cod punct de lucru', 'Data documentului', 'Sursa documentului', ...(serials ? ['Referință document'] : [])],
      ...report.detail.rows.map(row => [
        row.date, focusCountyLabel(row.county), focusCategoryLabel(row.category, territory), focusKindLabels[row.kind], row.site ?? null,
        ...(serials ? [row.serial ?? null] : []), row.clientCode ?? null, row.pointCode ?? null,
        row.document?.date ?? null, row.document?.source === 'slip' ? 'Aviz SIM' : row.document?.source === 'erp' ? 'ERP' : null,
        ...(serials ? [row.document?.reference ?? null] : []),
      ]),
    ], [16, 18, 32, 25, 16, 22, 17, 20, 18, 20, 22]);
  }
  return write(workbook, {type: 'base64', bookType: 'xlsx', compression: true});
}
