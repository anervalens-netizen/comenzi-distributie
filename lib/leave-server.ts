import { randomUUID, createHash } from 'node:crypto';
import {
  db,
  fail,
  response,
  jsonBody,
  readLimited,
  textField,
  requireManager,
  requireGlobalManager,
  requireAgentAccess,
  isGlobalManager,
} from './server';
import { operationalWriteGuard } from './operational-write-guard';
import { leaveDays, parseDay } from './leave-calendar';
import {
  generateLeavePdf,
  invalidLeavePdfText,
  invalidLeaveScan,
  leavePdfSupportsText,
  scanToPdf,
} from './leave-pdf';
import { notificationInsert } from './notification-center';
import { sendNotificationPush } from './push-notifications';
import type { User } from './types';
import type {
  EmployeeProfile,
  LeaveRecord,
  LeaveSnapshot,
  Stroke,
} from './leave-types';

type Row = {
  id: string;
  agent_id: string;
  approver_id: string;
  start_date: string;
  end_date: string;
  days: number;
  status: LeaveRecord['status'];
  snapshot: string;
  signature: string | null;
  signed_at: string | null;
  submitted_at: string | null;
  decision_note: string;
  created_at: string;
  updated_at: string;
  revision: number;
};
type ProfileRow = {
  user_id: string;
  legal_name: string;
  employer: string;
  email: string;
  approver_id: string | null;
  approver_email: string;
  approvers: string;
  holiday_calendar: 'orthodox' | 'western';
  extra_holidays: string;
  verified: number;
  revision: number;
};
const uuid = (s: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const validEmail = (s: string) =>
  /^[^\s@,;<>\r\n]+@[^\s@,;<>\r\n]+\.[^\s@,;<>\r\n]+$/.test(s);
const now = () => new Date().toISOString();
async function hrEmail() {
  const row = await db()
    .prepare("SELECT value FROM settings WHERE key='leave-mail-to-v1'")
    .first<{ value: string }>();
  return row?.value || '';
}
const clean = (v: unknown, max: number) =>
  Array.from(textField(v, max), (c) =>
    c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? ' ' : c,
  ).join('');
function revision(v: unknown) {
  if (!Number.isSafeInteger(v) || Number(v) < 1)
    fail(400, 'Versiunea cererii lipsește.');
  return Number(v);
}
type Approver = { id: string; email: string };
type ManagerChoice = Approver & { name: string };

function storedApprovers(p: ProfileRow): Approver[] {
  const saved = JSON.parse(p.approvers || '[]') as Approver[];
  return saved.length
    ? saved
    : p.approver_id
      ? [{ id: p.approver_id, email: p.approver_email }]
      : [];
}
function sameApprovers(approvers: Approver[], eligible: ManagerChoice[]) {
  const ids = new Set(approvers.map((approver) => approver.id));
  return (
    ids.size === approvers.length &&
    ids.size === eligible.length &&
    eligible.every((manager) => ids.has(manager.id))
  );
}
function profileView(
  p: ProfileRow,
  eligible: ManagerChoice[],
): EmployeeProfile {
  const saved = storedApprovers(p),
    emailById = new Map(saved.map((approver) => [approver.id, approver.email]));
  const approvers = eligible.map(({ id, email }) => ({
    id,
    email: emailById.get(id) || email,
  }));
  const verified =
    !!p.verified &&
    approvers.length > 0 &&
    sameApprovers(saved, eligible) &&
    saved.every((approver) => validEmail(approver.email));
  return {
    userId: p.user_id,
    legalName: p.legal_name,
    employer: p.employer,
    email: p.email,
    approverId: approvers[0]?.id ?? null,
    approverEmail: approvers[0]?.email ?? '',
    approvers,
    holidayCalendar: p.holiday_calendar,
    extraHolidays: JSON.parse(p.extra_holidays),
    verified,
    revision: p.revision,
  };
}
function snapshotApprovers(
  primaryId: string,
  snapshot: LeaveSnapshot,
): ManagerChoice[] {
  return snapshot.approvers?.length
    ? snapshot.approvers
    : [
        {
          id: primaryId,
          name: snapshot.approverName,
          email: snapshot.approverEmail,
        },
      ];
}
function view(r: Row, user: User): LeaveRecord {
  const snapshot = JSON.parse(r.snapshot) as LeaveSnapshot;
  const canDecide =
    user.role === 'manager' &&
    (isGlobalManager(user) ||
      snapshotApprovers(r.approver_id, snapshot).some(
        (approver) => approver.id === user.id,
      ));
  return {
    id: r.id,
    agentId: r.agent_id,
    approverId: r.approver_id,
    startDate: r.start_date,
    endDate: r.end_date,
    days: r.days,
    status: r.status,
    snapshot,
    signedAt: r.signed_at,
    submittedAt: r.submitted_at,
    decisionNote: r.decision_note,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    revision: r.revision,
    canDecide,
  };
}
function scope(user: User, alias = 'r') {
  return user.role === 'agent'
    ? { sql: alias + '.agent_id=?', args: [user.id] }
    : isGlobalManager(user)
      ? { sql: '1=1', args: [] }
      : {
          sql:
            'EXISTS (SELECT 1 FROM manager_agents ma WHERE ma.manager_id=? AND ma.agent_id=' +
            alias +
            '.agent_id)',
          args: [user.id],
        };
}
async function profile(agentId: string) {
  const row = await db()
    .prepare('SELECT * FROM employee_profiles WHERE user_id=?')
    .bind(agentId)
    .first<ProfileRow>();
  if (!row)
    fail(
      409,
      'Profilul angajatului nu este încă disponibil. Managerul îl poate configura.',
    );
  return row;
}
// All current active assigned managers are required. Global decision access is
// handled by the authorization predicate, independently of email recipients.
function eligibleManagers(agentExpr: string) {
  const assigned =
    'SELECT assigned.id FROM manager_agents ma JOIN users assigned ON assigned.id=ma.manager_id WHERE ma.agent_id=' +
    agentExpr +
    " AND assigned.active=1 AND assigned.role='manager'";
  return assigned;
}
function uniqueEmails(emails: string[]) {
  const distinct = new Map<string, string>();
  for (const email of emails) {
    if (validEmail(email) && !distinct.has(email.toLowerCase()))
      distinct.set(email.toLowerCase(), email);
  }
  return [...distinct.values()];
}
function managerEmail(value: string | null) {
  if (!value) return '';
  const settings = JSON.parse(value) as Record<string, unknown>;
  const emails = uniqueEmails(
    ['partner', 'accessories', 'stands', 'sim']
      .map((key) => settings[key])
      .filter((email): email is string => typeof email === 'string')
      .map((email) => email.trim()),
  );
  return emails.length === 1 ? emails[0] : '';
}
async function choicesByAgent(agentIds: string[]) {
  const result = new Map<string, ManagerChoice[]>();
  if (!agentIds.length) return result;
  const rows = await db()
    .prepare(
      'SELECT a.value agentId,m.id,m.name,s.value FROM json_each(?) a JOIN users m ON m.id IN (' +
        eligibleManagers('a.value') +
        ') ' +
        "LEFT JOIN settings s ON s.key='manager-mail:'||m.id ORDER BY m.name COLLATE NOCASE,m.id",
    )
    .bind(JSON.stringify(agentIds))
    .all<{ agentId: string; id: string; name: string; value: string | null }>();
  for (const row of rows.results) {
    let email = '';
    try {
      email = managerEmail(row.value);
    } catch {
      /* Leave ambiguous or malformed settings for a manager to confirm. */
    }
    const choice = { id: row.id, name: row.name, email };
    const previous = result.get(row.agentId);
    if (previous) previous.push(choice);
    else result.set(row.agentId, [choice]);
  }
  return result;
}
async function choicesFor(agentId: string) {
  return (await choicesByAgent([agentId])).get(agentId) || [];
}
function approverSetGuard(agentId: string, approvers: Approver[]) {
  const eligible = eligibleManagers('expected.agent_id');
  return {
    sql:
      'EXISTS (SELECT 1 FROM (SELECT ? AS agent_id,? AS ids) expected ' +
      'WHERE (SELECT COUNT(*) FROM (' +
      eligible +
      '))=json_array_length(expected.ids) ' +
      'AND NOT EXISTS (SELECT 1 FROM json_each(expected.ids) a WHERE a.value NOT IN (' +
      eligible +
      ')))',
    args: [agentId, JSON.stringify(approvers.map((approver) => approver.id))],
  };
}
async function profiles(user: User, params = new URLSearchParams()) {
  const filter =
    user.role === 'agent'
      ? { sql: 'u.id=?', args: [user.id] }
      : isGlobalManager(user)
        ? { sql: '1=1', args: [] }
        : {
            sql: 'EXISTS(SELECT 1 FROM manager_agents ma WHERE ma.manager_id=? AND ma.agent_id=u.id)',
            args: [user.id],
          };
  const selectedAgent = params.get('agentId'),
    selectedManager = params.get('managerId');
  if (selectedAgent) {
    filter.sql += ' AND u.id=?';
    filter.args.push(selectedAgent);
  }
  if (selectedManager) {
    filter.sql +=
      ' AND EXISTS(SELECT 1 FROM manager_agents chosen WHERE chosen.manager_id=? AND chosen.agent_id=u.id)';
    filter.args.push(selectedManager);
  }
  const rows = await db()
    .prepare(
      "SELECT p.* FROM employee_profiles p JOIN users u ON u.id=p.user_id WHERE u.role='agent' AND u.active=1 AND " +
        filter.sql +
        ' ORDER BY p.legal_name,p.user_id',
    )
    .bind(...filter.args)
    .all<ProfileRow>();
  const choices = await choicesByAgent(rows.results.map((row) => row.user_id));
  const managers = new Map<string, ManagerChoice & { agentIds: string[] }>();
  if (user.role === 'manager') {
    for (const [agentId, eligible] of choices) {
      for (const manager of eligible) {
        const previous = managers.get(manager.id);
        if (previous) previous.agentIds.push(agentId);
        else managers.set(manager.id, { ...manager, agentIds: [agentId] });
      }
    }
  }
  return {
    profiles: rows.results.map((row) =>
      profileView(row, choices.get(row.user_id) || []),
    ),
    managers: [...managers.values()],
    hrEmail: await hrEmail(),
  };
}
async function get(id: string, user: User) {
  if (!uuid(id)) fail(404, 'Cererea nu a fost găsită.');
  const s = scope(user),
    row = await db()
      .prepare('SELECT r.* FROM leave_requests r WHERE r.id=? AND ' + s.sql)
      .bind(id, ...s.args)
      .first<Row>();
  if (!row) fail(404, 'Cererea nu a fost găsită.');
  return row;
}
function requirePdfProfileText(legalName: string, employer: string) {
  if (!leavePdfSupportsText(legalName) || !leavePdfSupportsText(employer))
    fail(400, invalidLeavePdfText);
}
async function prepare(agentId: string, start: string, end: string) {
  const [p, to, eligible] = await Promise.all([
    profile(agentId),
    hrEmail(),
    choicesFor(agentId),
  ]);
  if (!validEmail(to))
    fail(
      409,
      'Managerul general trebuie să configureze adresa HR pentru concedii.',
    );
  const saved = storedApprovers(p);
  if (
    !p.verified ||
    !p.legal_name ||
    !p.employer ||
    !saved.length ||
    !saved.every((approver) => validEmail(approver.email)) ||
    !sameApprovers(saved, eligible)
  ) {
    fail(
      409,
      'Managerul trebuie să confirme numele, angajatorul și adresele tuturor aprobatorilor din Profiluri angajați.',
    );
  }
  requirePdfProfileText(p.legal_name, p.employer);
  const addresses = new Map(
    saved.map((approver) => [approver.id, approver.email]),
  );
  const approvers = eligible.map(({ id, name }) => ({
    id,
    name,
    email: addresses.get(id)!,
  }));
  const primary = approvers[0];
  let calc: ReturnType<typeof leaveDays>;
  try {
    calc = leaveDays(
      start,
      end,
      p.holiday_calendar,
      JSON.parse(p.extra_holidays),
    );
  } catch (e) {
    fail(400, (e as Error).message);
  }
  const snapshot: LeaveSnapshot = {
    legalName: p.legal_name,
    employer: p.employer,
    approverName: primary.name,
    approverEmail: primary.email,
    approvers,
    to,
    workingDates: calc.workingDates,
    excludedDates: calc.excludedDates,
    calendar: p.holiday_calendar,
    profileRevision: p.revision,
  };
  return { approverId: primary.id, snapshot, days: calc.days };
}
function profileGuard(
  agentId: string,
  primaryId: string,
  snapshot: LeaveSnapshot,
) {
  const managers = approverSetGuard(
    agentId,
    snapshotApprovers(primaryId, snapshot),
  );
  return {
    sql:
      "EXISTS(SELECT 1 FROM employee_profiles p JOIN users a ON a.id=p.user_id WHERE p.user_id=? AND p.revision=? AND p.verified=1 AND a.active=1 AND a.role='agent') " +
      "AND EXISTS(SELECT 1 FROM settings WHERE key='leave-mail-to-v1' AND value=?) AND " +
      managers.sql,
    args: [agentId, snapshot.profileRevision, snapshot.to, ...managers.args],
  };
}
function eventInsert(
  id: string,
  requestId: string,
  user: User,
  action: string,
  note: string,
  time: string,
) {
  return db()
    .prepare(
      'INSERT INTO leave_events(id,request_id,actor_id,action,note,created_at) SELECT ?,?,?,?,?,? WHERE changes()=1',
    )
    .bind(id, requestId, user.id, action, note, time);
}
function conflict(): never {
  fail(
    409,
    'Cererea, profilul sau accesul s-a modificat, ori perioada se suprapune unei cereri active. Reîncarcă datele.',
  );
}
function periodLabel(start: string, end: string) {
  const date = (value: string) => value.split('-').reverse().join('.');
  return date(start) + '–' + date(end);
}
function mail(r: LeaveRecord) {
  const date = (s: string) => s.split('-').reverse().join('.');
  const subject =
    'Cerere concediu — ' +
    r.snapshot.legalName +
    ' — ' +
    date(r.startDate) +
    '–' +
    date(r.endDate);
  const to = r.snapshot.to;
  const approvers = snapshotApprovers(r.approverId, r.snapshot).filter(
    (approver) =>
      validEmail(approver.email) &&
      approver.email.toLowerCase() !== to.toLowerCase(),
  );
  const cc = uniqueEmails(approvers.map((approver) => approver.email));
  const recipientsInBody = approvers.length
    ? '\n\nManageri în CC — ' +
      approvers
        .map((approver) => approver.name + ' (' + approver.email + ')')
        .join(', ')
    : '';
  const body =
    'Bună ziua,\n\nVă transmit atașat cererea de concediu de odihnă pentru perioada ' +
    date(r.startDate) +
    '–' +
    date(r.endDate) +
    ', însumând ' +
    r.days +
    ' zile lucrătoare.\n\n' +
    r.snapshot.legalName +
    recipientsInBody;
  const filename =
    'cerere-concediu-' +
    r.snapshot.legalName
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .slice(0, 65) +
    '-' +
    r.startDate +
    '.pdf';
  return {
    to,
    cc,
    subject,
    body,
    filename,
    mailto:
      'mailto:' +
      encodeURIComponent(to) +
      '?cc=' +
      encodeURIComponent(cc.join(',')) +
      '&subject=' +
      encodeURIComponent(subject) +
      '&body=' +
      encodeURIComponent(body),
  };
}
function strokes(value: unknown): Stroke[] {
  if (!Array.isArray(value) || !value.length || value.length > 100)
    fail(400, 'Semnează în caseta de semnătură.');
  let points = 0,
    length = 0;
  const result: Stroke[] = value.map((raw) => {
    if (!Array.isArray(raw) || raw.length < 2)
      fail(400, 'Semnătura este incompletă.');
    const stroke = raw.map((p) => {
      if (
        !p ||
        typeof p !== 'object' ||
        !Number.isFinite(p.x) ||
        !Number.isFinite(p.y) ||
        p.x < 0 ||
        p.x > 1 ||
        p.y < 0 ||
        p.y > 1
      )
        fail(400, 'Semnătura este invalidă.');
      points++;
      if (points > 5000) fail(400, 'Semnătura este prea complexă.');
      return { x: Number(p.x), y: Number(p.y) };
    });
    for (let i = 1; i < stroke.length; i++)
      length += Math.hypot(
        stroke[i].x - stroke[i - 1].x,
        stroke[i].y - stroke[i - 1].y,
      );
    return stroke;
  });
  if (points < 5 || length < 0.1) fail(400, 'Semnătura este prea scurtă.');
  return result;
}
function leaveNotifications(
  ids: string[],
  eventId: string,
  requestId: string,
  time: string,
  title: string,
  body: string,
) {
  const guard = {
    sql: 'EXISTS(SELECT 1 FROM leave_events WHERE id=?)',
    args: [eventId],
  };
  return ids.map((recipientId) =>
    notificationInsert(
      {
        recipientId,
        eventKey: eventId,
        category: 'leave',
        title,
        body,
        targetType: 'leave',
        targetId: requestId,
        createdAt: time,
      },
      guard,
    ),
  );
}
function pushNotifications(ids: string[], eventId: string) {
  for (const id of ids) void sendNotificationPush(id, eventId).catch(() => {});
}
async function submit(
  req: Request,
  user: User,
  row: Row,
  version: number,
  signature: Stroke[] | null,
  scan?: Uint8Array,
) {
  if (user.role !== 'agent' || row.agent_id !== user.id)
    fail(403, 'Doar solicitantul poate semna și depune cererea.');
  if (row.status !== 'draft' || row.revision !== version) conflict();
  const snapshot = JSON.parse(row.snapshot) as LeaveSnapshot;
  const [p, to, eligible] = await Promise.all([
    profile(user.id),
    hrEmail(),
    choicesFor(user.id),
  ]);
  const approvers = snapshotApprovers(row.approver_id, snapshot);
  if (
    p.revision !== snapshot.profileRevision ||
    to !== snapshot.to ||
    !sameApprovers(approvers, eligible)
  ) {
    fail(
      409,
      'Profilul, aprobatorii sau adresa HR s-au schimbat. Salvează din nou perioada înainte de semnare.',
    );
  }
  const recipients = approvers.map((approver) => approver.id);
  const time = now(),
    newVersion = version + 1,
    eventId = randomUUID(),
    record = view(
      {
        ...row,
        status: 'submitted',
        signed_at: time,
        submitted_at: time,
        revision: newVersion,
      },
      user,
    );
  requirePdfProfileText(snapshot.legalName, snapshot.employer);
  const bytes = scan || (await generateLeavePdf(record, signature));
  const guard = operationalWriteGuard(req, user, { agentId: user.id }),
    pg = profileGuard(user.id, row.approver_id, snapshot);
  const changed = db()
    .prepare(
      "UPDATE leave_requests SET status='submitted',signature=?,signed_at=?,submitted_at=?,updated_at=?,revision=revision+1 WHERE id=? AND agent_id=? AND status='draft' AND revision=? AND " +
        guard.sql +
        ' AND ' +
        pg.sql +
        " AND NOT EXISTS(SELECT 1 FROM leave_requests other WHERE other.agent_id=leave_requests.agent_id AND other.id<>leave_requests.id AND other.status IN ('submitted','approved') AND other.start_date<=leave_requests.end_date AND other.end_date>=leave_requests.start_date)",
    )
    .bind(
      signature ? JSON.stringify(signature) : null,
      time,
      time,
      time,
      row.id,
      user.id,
      version,
      ...guard.args,
      ...pg.args,
    );
  const eventGuard = {
    sql: 'EXISTS(SELECT 1 FROM leave_events WHERE id=?)',
    args: [eventId],
  };
  const result = await db().batch([
    changed,
    eventInsert(
      eventId,
      row.id,
      user,
      'submitted',
      scan
        ? 'Cerere semnată pe hârtie, fotografiată.'
        : 'Semnătură desenată pe dispozitiv.',
      time,
    ),
    db()
      .prepare(
        "INSERT INTO leave_documents(request_id,version,kind,content,mime,digest,created_at) SELECT ?,?,'signed',?,'application/pdf',?,? WHERE " +
          eventGuard.sql,
      )
      .bind(
        row.id,
        newVersion,
        Buffer.from(bytes).toString('base64'),
        createHash('sha256').update(bytes).digest('hex'),
        time,
        ...eventGuard.args,
      ),
    ...leaveNotifications(
      recipients,
      eventId,
      row.id,
      time,
      'Cerere de concediu nouă',
      snapshot.legalName +
        ' · ' +
        periodLabel(row.start_date, row.end_date) +
        ' · ' +
        row.days +
        ' zile lucrătoare.',
    ),
  ]);
  if (!result[0].meta.changes) conflict();
  pushNotifications(recipients, eventId);
  return response({ request: view(await get(row.id, user), user) });
}
export async function leaveApi(req: Request, user: User, path: string[]) {
  const [, id, action] = path,
    url = new URL(req.url);
  if (id === 'config' && !action) {
    if (req.method === 'GET') return response({ to: await hrEmail() });
    requireGlobalManager(user);
    if (req.method !== 'PUT') fail(405, 'Operațiune indisponibilă.');
    const body = await jsonBody(req),
      to = clean(body.to, 254);
    if (!validEmail(to)) fail(400, 'Adresă HR invalidă.');
    const guard = operationalWriteGuard(req, user, { globalOnly: true });
    const result = await db()
      .prepare(
        "INSERT INTO settings(key,value) SELECT 'leave-mail-to-v1',? WHERE " +
          guard.sql +
          ' ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .bind(to, ...guard.args)
      .run();
    if (!result.meta.changes) conflict();
    return response({ to });
  }

  if (id === 'profiles') {
    if (req.method === 'GET' && !action)
      return response(await profiles(user, url.searchParams));
    if (req.method !== 'PUT' || !action) fail(405, 'Operațiune indisponibilă.');
    requireManager(user);
    await requireAgentAccess(user, action);
    const [body, eligible] = await Promise.all([
      jsonBody(req),
      choicesFor(action),
    ]);
    const legalName = clean(body.legalName, 160),
      employer = clean(body.employer, 180),
      email = clean(body.email, 254),
      calendar = body.holidayCalendar;
    if (
      !legalName ||
      !employer ||
      (email && !validEmail(email)) ||
      !['orthodox', 'western'].includes(String(calendar))
    )
      fail(400, 'Completează numele, firma și calendarul angajatului.');
    requirePdfProfileText(legalName, employer);
    const supplied =
      body.approvers === undefined
        ? [{ id: body.approverId, email: body.approverEmail }]
        : body.approvers;
    if (
      !Array.isArray(supplied) ||
      !supplied.length ||
      supplied.length !== eligible.length
    )
      fail(400, 'Completează adresele tuturor managerilor alocați.');
    const approvers: Approver[] = supplied.map((entry: unknown) => {
      if (
        !entry ||
        typeof entry !== 'object' ||
        !('id' in entry) ||
        !('email' in entry)
      )
        fail(400, 'Aprobator invalid.');
      const id = clean(entry.id, 128),
        address = clean(entry.email, 254);
      if (!id || !validEmail(address))
        fail(400, 'Completează o adresă validă pentru fiecare manager alocat.');
      return { id, email: address };
    });
    if (!sameApprovers(approvers, eligible))
      fail(
        400,
        'Aprobatorii trebuie să coincidă cu managerii alocați în prezent.',
      );
    const addresses = new Map(
      approvers.map((approver) => [approver.id, approver.email]),
    );
    const saved = eligible.map(({ id }) => ({ id, email: addresses.get(id)! }));
    const primary = saved[0],
      extra = body.extraHolidays;
    if (
      !Array.isArray(extra) ||
      extra.length > 120 ||
      extra.some((x) => typeof x !== 'string')
    )
      fail(400, 'Lista zilelor libere este invalidă.');
    try {
      extra.forEach((x) => parseDay(x));
    } catch {
      fail(400, 'O zi liberă suplimentară este invalidă.');
    }
    const guard = operationalWriteGuard(req, user, { agentId: action }),
      version = revision(body.revision),
      managers = approverSetGuard(action, saved);
    const result = await db()
      .prepare(
        'UPDATE employee_profiles SET legal_name=?,employer=?,email=?,approver_id=?,approver_email=?,approvers=?,holiday_calendar=?,extra_holidays=?,verified=?,revision=revision+1,updated_at=? WHERE user_id=? AND revision=? AND ' +
          guard.sql +
          ' AND ' +
          managers.sql,
      )
      .bind(
        legalName,
        employer,
        email,
        primary.id,
        primary.email,
        JSON.stringify(saved),
        String(calendar),
        JSON.stringify([...new Set(extra)]),
        body.verified === true ? 1 : 0,
        now(),
        action,
        version,
        ...guard.args,
        ...managers.args,
      )
      .run();
    if (!result.meta.changes) conflict();
    return response({
      profile: profileView(await profile(action), await choicesFor(action)),
    });
  }
  if (id === 'calendar' && req.method === 'GET') {
    const agentId =
      user.role === 'agent' ? user.id : url.searchParams.get('agentId') || '';
    await requireAgentAccess(user, agentId);
    const p = await profile(agentId);
    try {
      return response(
        leaveDays(
          url.searchParams.get('start') || '',
          url.searchParams.get('end') || '',
          p.holiday_calendar,
          JSON.parse(p.extra_holidays),
        ),
      );
    } catch (e) {
      fail(400, (e as Error).message);
    }
  }
  if (!id && req.method === 'GET') {
    const s = scope(user),
      clauses = [s.sql],
      args: (string | number)[] = [...s.args];
    const agentId = url.searchParams.get('agentId');
    if (agentId) {
      clauses.push('r.agent_id=?');
      args.push(agentId);
    }
    const managerId = url.searchParams.get('managerId');
    if (managerId) {
      clauses.push(
        'EXISTS(SELECT 1 FROM manager_agents mm WHERE mm.manager_id=? AND mm.agent_id=r.agent_id)',
      );
      args.push(managerId);
    }
    const month = url.searchParams.get('month'),
      year = url.searchParams.get('year'),
      status = url.searchParams.get('status');
    if (month) {
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) fail(400, 'Lună invalidă.');
      const start = month + '-01',
        end = new Date(
          Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0),
        )
          .toISOString()
          .slice(0, 10);
      clauses.push('r.end_date>=? AND r.start_date<=?');
      args.push(start, end);
    } else if (year) {
      if (!/^\d{4}$/.test(year)) fail(400, 'An invalid.');
      clauses.push('r.end_date>=? AND r.start_date<=?');
      args.push(year + '-01-01', year + '-12-31');
    }
    if (status && status !== 'all') {
      if (
        !['draft', 'submitted', 'approved', 'rejected', 'cancelled'].includes(
          status,
        )
      )
        fail(400, 'Status invalid.');
      clauses.push('r.status=?');
      args.push(status);
    }
    const offset = Math.max(
        0,
        Math.min(100000, Number(url.searchParams.get('offset')) || 0),
      ),
      limit = Math.max(
        1,
        Math.min(100, Number(url.searchParams.get('limit')) || 50),
      );
    if (!Number.isInteger(offset) || !Number.isInteger(limit))
      fail(400, 'Paginare invalidă.');
    const where = clauses.join(' AND '),
      rows = await db()
        .prepare(
          'SELECT r.* FROM leave_requests r WHERE ' +
            where +
            ' ORDER BY r.created_at DESC,r.id DESC LIMIT ? OFFSET ?',
        )
        .bind(...args, limit, offset)
        .all<Row>();
    const total = (await db()
      .prepare('SELECT COUNT(*) n FROM leave_requests r WHERE ' + where)
      .bind(...args)
      .first<{ n: number }>())!.n;
    return response({
      items: rows.results.map((r) => view(r, user)),
      total,
      hasMore: offset + rows.results.length < total,
      ...(await profiles(user, url.searchParams)),
    });
  }
  if (!id && req.method === 'POST') {
    if (user.role !== 'agent')
      fail(403, 'Concediul se solicită din contul agentului.');
    const body = await jsonBody(req),
      requestId = clean(body.id, 60),
      start = typeof body.startDate === 'string' ? body.startDate : '',
      end = typeof body.endDate === 'string' ? body.endDate : '';
    if (!uuid(requestId)) fail(400, 'Identificator invalid.');
    const guard = operationalWriteGuard(req, user, { agentId: user.id });
    const replay = () =>
      db()
        .prepare(
          'SELECT * FROM leave_requests WHERE id=? AND agent_id=? AND start_date=? AND end_date=? AND ' +
            guard.sql,
        )
        .bind(requestId, user.id, start, end, ...guard.args)
        .first<Row>();
    const existing = await replay();
    if (existing) return response({ request: view(existing, user) });
    const { approverId, snapshot, days } = await prepare(user.id, start, end),
      pg = profileGuard(user.id, approverId, snapshot),
      time = now(),
      eventId = randomUUID();
    const result = await db().batch([
      db()
        .prepare(
          "INSERT INTO leave_requests(id,agent_id,approver_id,start_date,end_date,days,status,snapshot,created_at,updated_at) SELECT ?,?,?,?,?,?,'draft',?,?,? WHERE " +
            guard.sql +
            ' AND ' +
            pg.sql +
            ' ON CONFLICT(id) DO NOTHING',
        )
        .bind(
          requestId,
          user.id,
          approverId,
          start,
          end,
          days,
          JSON.stringify(snapshot),
          time,
          time,
          ...guard.args,
          ...pg.args,
        ),
      eventInsert(eventId, requestId, user, 'created', '', time),
    ]);
    if (result[0].meta.changes)
      return response({ request: view(await get(requestId, user), user) }, 201);
    const concurrent = await replay();
    if (!concurrent) conflict();
    return response({ request: view(concurrent, user) });
  }
  if (!id) fail(405, 'Operațiune indisponibilă.');
  const row = await get(id, user),
    record = view(row, user);
  if (req.method === 'GET' && !action) {
    const events = await db()
      .prepare(
        'SELECT e.id,e.action,e.note,e.created_at createdAt,u.name actorName FROM leave_events e JOIN users u ON u.id=e.actor_id WHERE e.request_id=? ORDER BY e.created_at,e.id',
      )
      .bind(id)
      .all();
    return response({
      request: record,
      events: events.results,
      mail: mail(record),
    });
  }
  if (req.method === 'GET' && action === 'pdf') {
    const document = await db()
      .prepare(
        "SELECT content,digest FROM leave_documents WHERE request_id=? AND kind='signed' ORDER BY version DESC LIMIT 1",
      )
      .bind(id)
      .first<{ content: string; digest: string }>();
    let bytes: Uint8Array;
    if (document) {
      const stored = Buffer.from(document.content, 'base64');
      if (
        stored.toString('base64') !== document.content ||
        createHash('sha256').update(stored).digest('hex') !== document.digest
      ) {
        fail(500, 'Integritatea PDF-ului semnat nu a putut fi confirmată.');
      }
      bytes = stored;
    } else {
      if (record.signedAt || record.submittedAt)
        fail(500, 'Documentul PDF semnat lipsește.');
      requirePdfProfileText(
        record.snapshot.legalName,
        record.snapshot.employer,
      );
      bytes = await generateLeavePdf(record, null);
    }
    // Recheck current authorization after asynchronous document generation.
    await get(id, user);
    return new Response(bytes as BodyInit, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition':
          'attachment; filename="' + mail(record).filename + '"',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }
  if (req.method === 'PUT' && !action) {
    if (
      user.role !== 'agent' ||
      row.agent_id !== user.id ||
      row.status !== 'draft'
    )
      fail(403, 'Doar ciornele proprii pot fi modificate.');
    const body = await jsonBody(req),
      version = revision(body.revision),
      start = typeof body.startDate === 'string' ? body.startDate : '',
      end = typeof body.endDate === 'string' ? body.endDate : '',
      { approverId, snapshot, days } = await prepare(user.id, start, end),
      time = now(),
      eventId = randomUUID();
    const guard = operationalWriteGuard(req, user, { agentId: user.id }),
      pg = profileGuard(user.id, approverId, snapshot);
    const result = await db().batch([
      db()
        .prepare(
          "UPDATE leave_requests SET approver_id=?,start_date=?,end_date=?,days=?,snapshot=?,signature=NULL,signed_at=NULL,updated_at=?,revision=revision+1 WHERE id=? AND agent_id=? AND status='draft' AND revision=? AND " +
            guard.sql +
            ' AND ' +
            pg.sql,
        )
        .bind(
          approverId,
          start,
          end,
          days,
          JSON.stringify(snapshot),
          time,
          id,
          user.id,
          version,
          ...guard.args,
          ...pg.args,
        ),
      eventInsert(
        eventId,
        id,
        user,
        'updated',
        'Perioadă actualizată; semnătura trebuie refăcută.',
        time,
      ),
    ]);
    if (!result[0].meta.changes) conflict();
    return response({ request: view(await get(id, user), user) });
  }
  if (req.method === 'POST' && action === 'submit') {
    const body = await jsonBody(req);
    return submit(
      req,
      user,
      row,
      revision(body.revision),
      strokes(body.signature),
    );
  }
  if (req.method === 'POST' && action === 'scan') {
    if (user.role !== 'agent' || row.agent_id !== user.id)
      fail(403, 'Doar solicitantul poate încărca cererea.');
    const version = revision(Number(url.searchParams.get('revision')));
    if (row.status !== 'draft' || row.revision !== version) conflict();
    const bytes = await readLimited(req, 4_000_000),
      mime = req.headers.get('Content-Type')?.split(';')[0] || '';
    let pdf: Uint8Array;
    try {
      pdf = await scanToPdf(bytes, mime);
    } catch {
      fail(400, invalidLeaveScan);
    }
    return submit(req, user, row, version, null, pdf);
  }
  if (req.method === 'POST' && action === 'decision') {
    const body = await jsonBody(req),
      version = revision(body.revision),
      status = body.status,
      note = clean(body.note, 1200);
    const ownRequest = user.role === 'agent' && row.agent_id === user.id;
    if ((ownRequest || record.canDecide) && row.revision !== version)
      conflict();
    const ownCancel =
      ownRequest &&
      ['draft', 'submitted'].includes(row.status) &&
      status === 'cancelled';
    const managerDecision =
      record.canDecide &&
      ((row.status === 'submitted' &&
        ['approved', 'rejected'].includes(String(status))) ||
        (row.status === 'approved' && status === 'cancelled'));
    if (!ownCancel && !managerDecision)
      fail(403, 'Această decizie nu este disponibilă.');
    if (['rejected', 'cancelled'].includes(String(status)) && !note)
      fail(400, 'Completează motivul.');
    const time = now(),
      eventId = randomUUID(),
      guard = operationalWriteGuard(req, user, { agentId: row.agent_id });
    const approvers = snapshotApprovers(row.approver_id, record.snapshot).map(
      (approver) => approver.id,
    );
    const recipients = ownCancel
      ? approvers
      : [row.agent_id, ...approvers.filter((id) => id !== user.id)];
    const approverGuard = ownCancel
      ? '1=1'
      : "(EXISTS(SELECT 1 FROM json_each(snapshot,'$.approvers') a WHERE json_extract(a.value,'$.id')=? ) OR " +
        "(COALESCE(json_array_length(snapshot,'$.approvers'),0)=0 AND approver_id=?) OR EXISTS(SELECT 1 FROM users WHERE id=? AND role='manager' AND manager_scope='global'))";
    const title = 'Cerere de concediu actualizată';
    const summary =
      record.snapshot.legalName +
      ' · ' +
      periodLabel(record.startDate, record.endDate) +
      ' · ' +
      ({ approved: 'Aprobată', rejected: 'Respinsă', cancelled: 'Anulată' }[
        String(status)
      ] || '');
    const result = await db().batch([
      db()
        .prepare(
          'UPDATE leave_requests SET status=?,decision_note=?,updated_at=?,revision=revision+1 WHERE id=? AND status=? AND revision=? AND ' +
            guard.sql +
            ' AND ' +
            approverGuard,
        )
        .bind(
          String(status),
          note,
          time,
          id,
          row.status,
          version,
          ...guard.args,
          ...(ownCancel ? [] : [user.id, user.id, user.id]),
        ),
      eventInsert(eventId, id, user, String(status), note, time),
      ...leaveNotifications(recipients, eventId, id, time, title, summary),
    ]);
    if (!result[0].meta.changes) conflict();
    pushNotifications(recipients, eventId);
    return response({ request: view(await get(id, user), user) });
  }
  fail(405, 'Operațiune indisponibilă.');
}
