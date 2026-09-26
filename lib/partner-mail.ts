import { Buffer } from 'node:buffer';
import { db, fail, jsonBody, response, settingsForAgent, textField } from './server';
import type { ManagerMailSettings, PartnerMail, PartnerRequest, User } from './types';
import { savePartnerRequest } from './partner-requests';

const emailPattern = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

function clean(value: unknown, limit: number) {
  return textField(value, limit);
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

function managerAddress(value: Partial<ManagerMailSettings>) {
  return [value.partner, value.accessories, value.stands, value.sim]
    .find(entry => typeof entry === 'string' && entry.trim())?.trim() || '';
}

async function regionalRecipients(agentId: string) {
  const rows = await db().prepare("SELECT m.id,s.value FROM manager_agents ma JOIN users m ON m.id=ma.manager_id AND m.role='manager' AND m.manager_scope='assigned' AND m.active=1 LEFT JOIN settings s ON s.key='manager-mail:'||m.id WHERE ma.agent_id=? ORDER BY m.username").bind(agentId).all<{id:string;value:string|null}>();
  if (!rows.results.length) fail(409, 'Contul tău nu are un manager regional alocat.');
  const recipients: string[] = [];
  for (const row of rows.results) {
    if (!row.value) continue;
    let parsed: Partial<ManagerMailSettings>;
    try { parsed = JSON.parse(row.value); } catch { continue; }
    const address = managerAddress(parsed);
    if (address && emailPattern.test(address)) recipients.push(address);
  }
  const unique = [...new Set(recipients)];
  if (!unique.length) fail(409, 'Managerul regional nu are o adresă de e-mail configurată pentru Partener nou.');
  return unique;
}

function parsePartner(body: Record<string, unknown>): PartnerRequest {
  const result: PartnerRequest = {
    company: clean(body.company, 200),
    location: clean(body.location, 100),
    cui: clean(body.cui, 40),
    storeType: clean(body.storeType, 80),
    contact: clean(body.contact, 120),
    phone: clean(body.phone, 40),
    email: clean(body.email, 254),
    address: clean(body.address, 500),
    county: clean(body.county, 100),
  };
  if (!result.company || !result.location || !result.cui || !result.storeType || !result.contact || !result.phone || !result.address || !result.county) fail(400, 'Completează toate câmpurile obligatorii.');
  if (result.email && !emailPattern.test(result.email)) fail(400, 'Adresa de e-mail a partenerului nu este validă.');
  return result;
}
function bodyFor(partner: PartnerRequest) {
  return `Buna ziua,\n\nVa rog sa ma ajutati cu creare partener nou,\n\nFirma: ${partner.company}\nLocatia: ${partner.location}\nCUI: ${partner.cui}\nTip magazin: ${partner.storeType}\nPersoana de contact: ${partner.contact}\nNr Tel: ${partner.phone}\nAdresa Mail: ${partner.email || '-'}\nAdresa Magazin: ${partner.address}\nJudet: ${partner.county}\n\nMultumesc.`;
}

function htmlFor(partner: PartnerRequest) {
  const rows = [
    ['Firma', partner.company], ['Locatia', partner.location], ['CUI', partner.cui],
    ['TIP MAGAZIN', partner.storeType], ['Persoana de contact', partner.contact],
    ['Nr Tel', partner.phone], ['Adresa Mail', partner.email || '-'],
    ['Adresa Magazin', partner.address], ['Judet', partner.county],
  ];
  const head = rows.map(([label]) => `<th style="border:1px solid #333;padding:6px 8px;background:#f5f5f5">${escapeHtml(label)}</th>`).join('');
  const values = rows.map(([, value]) => `<td style="border:1px solid #333;padding:6px 8px">${escapeHtml(value)}</td>`).join('');
  return `<html><body style="font-family:Arial,sans-serif;font-size:14px"><p>Buna ziua,</p><p>Va rog sa ma ajutati cu creare partener nou,</p><table style="border-collapse:collapse"><tr>${head}</tr><tr>${values}</tr></table><p style="margin-top:28px">Multumesc.</p></body></html>`;
}

function emlForPartner(mail: PartnerMail, html: string) {
  const boundary = `mobiup_partner_${crypto.randomUUID()}`;
  const base64 = (value: string) => Buffer.from(value).toString('base64').match(/.{1,76}/g)?.join('\r\n') || '';
  return `MIME-Version: 1.0\r\nX-Unsent: 1\r\nTo: ${mail.to}\r\nCc: ${mail.cc.join(', ')}\r\nSubject: =?UTF-8?B?${Buffer.from(mail.subject).toString('base64')}?=\r\nContent-Type: multipart/alternative; boundary="${boundary}"\r\n\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64(mail.body)}\r\n--${boundary}\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64(html)}\r\n--${boundary}--\r\n`;
}
export async function partnerMail(req: Request, user: User) {
  if (user.role !== 'agent') fail(403, 'Cererea de partener nou se generează din contul agentului.');
  const input=await jsonBody(req);
  const partner = parsePartner(input);
  const regional = await regionalRecipients(user.id);
  const cfg = await settingsForAgent(user.id);
  const partnerTo = cfg.partnerTo.filter(Boolean);
  if (!partnerTo.length) fail(409, 'Nu este configurat niciun destinatar pentru Partener nou.');
  const to = partnerTo.join(',');
  const cc = [...new Set([...regional, ...cfg.partnerCc.filter(Boolean)])];
  const subject = `Creare partener nou ${partner.company}`;
  const body = bodyFor(partner);
  const mailto = `mailto:${encodeURIComponent(to)}?cc=${encodeURIComponent(cc.join(','))}&subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  const slug = partner.company.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9.-]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'partener';
  const mail: PartnerMail = { to, cc, subject, body, mailto, emlFilename: `creare-partener-${slug}.eml` };
  const request=await savePartnerRequest(user,input.requestId,input.revision,partner);
  return response({ partner, request, mail, eml: emlForPartner(mail, htmlFor(partner)) });
}
