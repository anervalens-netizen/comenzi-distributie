/**
 * Read only the membership value used by SQLite json_each/json_extract.
 * JSON.parse validates the grammar. The scanner retains raw child text because
 * SQLite returns nested objects/arrays as compact JSON without rewriting number
 * lexemes, escaped keys or duplicate keys. It is not a JSONB normalization.
 */
type Member = { key?: string; raw: string };
export type CustomerMembershipIneligibility = 'source_json_not_strict' | 'embedded_membership_not_strict'
  | 'source_unicode' | 'decoded_membership_unicode' | 'nesting_limit';
export class CustomerMembershipEligibilityError extends Error {
  constructor(readonly reason: CustomerMembershipIneligibility) {
    super('Customer membership snapshot is ineligible: ' + reason);
    this.name = 'CustomerMembershipEligibilityError';
  }
}
function strictJson(source: string, reason: CustomerMembershipIneligibility): unknown {
  try { return JSON.parse(source); }
  catch { throw new CustomerMembershipEligibilityError(reason); }
}
function unicode(source: string, reason: CustomerMembershipIneligibility): void {
  for (const char of source) {
    const point = char.codePointAt(0)!;
    if (point >= 0xd800 && point <= 0xdfff) throw new CustomerMembershipEligibilityError(reason);
  }
}
const whitespace = (char: string) => char === ' ' || char === '\n' || char === '\r' || char === '\t';
const trim = (source: string) => source.replace(/^[ \n\r\t]+|[ \n\r\t]+$/g, '');
function skip(source: string, offset: number): number {
  while (offset < source.length && whitespace(source[offset])) offset++;
  return offset;
}
function end(source: string, start: number): number {
  let quoted = false, escaped = false, depth = 0;
  for (let index = start; index < source.length; index++) {
    const char = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') { quoted = false; if (depth === 0) return index + 1; }
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === '[' || char === '{') {
      if (++depth > 1000) throw new CustomerMembershipEligibilityError('nesting_limit');
    } else if (char === ']' || char === '}') {
      if (depth === 0) return index;
      if (--depth === 0) return index + 1;
    } else if (depth === 0 && (char === ',' || whitespace(char))) return index;
  }
  return source.length;
}
function members(source: string): Member[] {
  const object = source[0] === '{';
  if (!object && source[0] !== '[') return [{ raw: source }];
  const result: Member[] = [];
  let offset = skip(source, 1);
  while (offset < source.length - 1) {
    let key: string | undefined;
    if (object) {
      const next = end(source, offset);
      key = JSON.parse(source.slice(offset, next));
      offset = skip(source, next);
      if (source[offset] !== ':') throw new Error('Invalid customer JSON object');
      offset = skip(source, offset + 1);
    }
    const next = end(source, offset);
    result.push({ key, raw: source.slice(offset, next) });
    offset = skip(source, next);
    if (source[offset] === ',') offset = skip(source, offset + 1); else break;
  }
  return result;
}
function compact(source: string): string {
  let result = '', quoted = false, escaped = false;
  for (const char of source) {
    if (!quoted && whitespace(char)) continue;
    result += char;
    if (quoted && escaped) escaped = false;
    else if (quoted && char === '\\') escaped = true;
    else if (char === '"') quoted = !quoted;
  }
  return result;
}

/**
 * Exact string-membership projection for the existing customer list predicate.
 * Numeric values are intentionally never coerced to text: list comparison has
 * no TEXT column affinity. User clientCount has a different CAST contract and
 * must not reuse this helper as a text-normalized count implementation.
 */
export function customerWarehouseValues(rawData: string, fallback: string | null): readonly (string | number | null)[] {
  const data = trim(rawData);
  unicode(data, 'source_unicode');
  if (fallback !== null) unicode(fallback, 'source_unicode');
  strictJson(data, 'source_json_not_strict');
  // Validate the same bounded nesting before enumerating any children.
  end(data, 0);
  const value = data[0] === '{' ? members(data).find(item => item.key === 'warehouseIds')?.raw : undefined;
  if (value === undefined || value === 'null') return [fallback];
  let root = value;
  if (root[0] === '"') {
    root = trim(JSON.parse(root) as string);
    unicode(root, 'decoded_membership_unicode');
  }
  // A JSON string from json_extract is parsed again by json_each. Thus a bare
  // warehouse name is an error, while a string containing a JSON array works.
  strictJson(root, 'embedded_membership_not_strict'); end(root, 0);
  return members(root).map(item => {
    if (item.raw[0] === '[' || item.raw[0] === '{') return compact(item.raw);
    const parsed: unknown = JSON.parse(item.raw);
    if (typeof parsed === 'string') unicode(parsed, 'decoded_membership_unicode');
    return typeof parsed === 'boolean' ? Number(parsed) : parsed as string | number | null;
  });
}

/**
 * Exact eligibility predicate for EVERY customer row in a final consistent
 * source snapshot, including inactive rows. A false result blocks migration;
 * it never rewrites JSON, accepts a fallback, or declares JSON5 parity.
 * General PostgreSQL TEXT, schema and application eligibility remain separate.
 */
export function customerMembershipEligibility(rawData: string, fallback: string | null):
  { eligible: true; reason: null } | { eligible: false; reason: CustomerMembershipIneligibility } {
  try { customerWarehouseValues(rawData, fallback); return { eligible: true, reason: null }; }
  catch (error) {
    if (error instanceof CustomerMembershipEligibilityError) return { eligible: false, reason: error.reason };
    throw error;
  }
}
