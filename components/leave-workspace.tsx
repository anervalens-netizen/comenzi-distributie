'use client';

import { useEffect, useRef, useState, type SubmitEvent } from 'react';
import {
  ArrowLeft,
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Download,
  FileText,
  Mail,
  PenLine,
  Plus,
  RefreshCw,
  Settings2,
  Upload,
} from 'lucide-react';
import { networkApi, ApiError, errorMessage } from '@/lib/client-api';
import {
  currentLocalWorkGeneration,
  currentLocalWorkUserId,
} from '@/lib/local-work';
import {
  leaveStatus,
  type EmployeeProfile,
  type LeaveEvent,
  type LeaveRecord,
  type Stroke,
} from '@/lib/leave-types';
import type { User } from '@/lib/types';
import { LeaveSignature, signaturePointLimit } from './leave-signature';

type Manager = { id: string; name: string; email?: string; agentIds: string[] };
type Profiles = {
  profiles: EmployeeProfile[];
  managers: Manager[];
  hrEmail: string;
};
type LeaveList = Profiles & {
  items: LeaveRecord[];
  total: number;
  hasMore: boolean;
};
type LeaveMail = {
  to: string;
  cc: string[];
  subject: string;
  body: string;
  filename: string;
  mailto: string;
};
type LeaveDetail = {
  request: LeaveRecord;
  events: LeaveEvent[];
  mail: LeaveMail | null;
};
type LeaveCount = {
  days: number;
  workingDates: string[];
  excludedDates: string[];
};
type LeaveResult = { request: LeaveRecord };
type Decision = 'approved' | 'rejected' | 'cancelled';
type View = 'history' | 'calendar' | 'profiles';

const dayFormatter = new Intl.DateTimeFormat('ro-RO', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});
const todayFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Bucharest',
  year: 'numeric',
  month: '2-digit',
});
const monthFormatter = new Intl.DateTimeFormat('ro-RO', {
  month: 'long',
  timeZone: 'UTC',
});
const calendarMonths = Array.from({ length: 12 }, (_, index) => {
  const value = String(index + 1).padStart(2, '0');
  return {
    value,
    label: monthFormatter.format(new Date('2025-' + value + '-01T00:00:00Z')),
  };
});
const calendarYears = Array.from({ length: 76 }, (_, index) =>
  String(2025 + index),
);
const currentMonth = () => {
  const parts = todayFormatter.formatToParts(new Date());
  return (
    parts.find((part) => part.type === 'year')!.value +
    '-' +
    parts.find((part) => part.type === 'month')!.value
  );
};
const dateLabel = (date: string) =>
  dayFormatter.format(new Date(date + 'T00:00:00Z'));
const periodLabel = (start: string, end: string) =>
  start === end ? dateLabel(start) : dateLabel(start) + ' – ' + dateLabel(end);
const dayCount = (days: number) =>
  days === 1 ? '1 zi lucrătoare' : days + ' zile lucrătoare';
const requestPath = (id: string) => 'leave/' + encodeURIComponent(id);
const profileReady = (profile?: EmployeeProfile) =>
  !!(
    profile?.verified &&
    profile.legalName &&
    profile.employer &&
    profile.approvers.length > 0 &&
    profile.approvers.every((approver) => !!approver.email)
  );
const iso = (date: Date) => date.toISOString().slice(0, 10);
const eventDate = new Intl.DateTimeFormat('ro-RO', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'Europe/Bucharest',
});

const eventLabels: Record<string, string> = {
  created: 'Ciornă creată',
  updated: 'Perioadă actualizată',
  submitted: 'Cerere depusă',
  signed: 'Semnată pe tabletă',
  scanned: 'Cerere semnată pe hârtie',
  approved: leaveStatus.approved,
  rejected: leaveStatus.rejected,
  cancelled: leaveStatus.cancelled,
};

function useLeaveData<T>(path: string, owner: string, refresh = 0) {
  const [state, setState] = useState<{
    key: string;
    data?: T;
    error?: string;
  }>();
  const key = [owner, path, refresh].join('|');
  useEffect(() => {
    const controller = new AbortController();
    void networkApi<T>(
      path,
      'GET',
      undefined,
      controller.signal,
      undefined,
      owner,
    )
      .then((data) => {
        if (!controller.signal.aborted) setState({ key, data });
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setState({ key, error: errorMessage(error) });
      });
    return () => controller.abort();
  }, [path, owner, key]);
  return state?.key === key ? state : { data: undefined, error: undefined };
}

function useLeaveAction() {
  const active = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => () => active.current?.abort(), []);
  async function run<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    onDone: (result: T) => void,
  ) {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError('');
    try {
      const result = await operation(controller.signal);
      if (!controller.signal.aborted) onDone(result);
    } catch (error) {
      if (!controller.signal.aborted) setError(errorMessage(error));
    } finally {
      active.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return { run, busy, error, setError };
}

async function leaveBinary(
  path: string,
  owner: string,
  signal: AbortSignal,
  file?: File,
) {
  const generation = currentLocalWorkGeneration();
  const assertOwner = () => {
    if (
      currentLocalWorkUserId() !== owner ||
      generation !== currentLocalWorkGeneration()
    ) {
      throw new Error('Contul s-a schimbat. Reîncarcă datele.');
    }
  };
  assertOwner();
  const headers = new Headers({ 'X-Operation-User': owner });
  if (file) headers.set('Content-Type', file.type);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  const timeout = setTimeout(() => {
    controller.abort(
      new Error(
        'Cererea a depășit timpul de așteptare. Verifică starea înainte de a reîncerca.',
      ),
    );
  }, 30000);
  try {
    const response = await fetch('/api/' + path, {
      method: file ? 'POST' : 'GET',
      body: file,
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal,
    });
    assertOwner();
    if (!response.ok) {
      const data = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      throw new ApiError(
        response.status,
        data?.error || 'Documentul nu a putut fi procesat.',
        data,
      );
    }
    if (
      file &&
      !response.headers.get('content-type')?.startsWith('application/json')
    ) {
      throw new Error('Încărcarea documentului nu a putut fi confirmată.');
    }
    if (
      !file &&
      !response.headers.get('content-type')?.startsWith('application/pdf')
    ) {
      throw new Error('Fișierul PDF nu a putut fi obținut.');
    }
    const result = file
      ? ((await response.json()) as LeaveResult)
      : await response.blob();
    assertOwner();
    return result;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', cancel);
  }
}

function downloadPdf(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function LeaveError({ children }: { children: string }) {
  return children ? (
    <p className="error-banner" role="alert">
      {children}
    </p>
  ) : null;
}

function Status({ status }: { status: LeaveRecord['status'] }) {
  return (
    <span className="leave-status" data-status={status}>
      {leaveStatus[status]}
    </span>
  );
}

function RequestRows({
  items,
  manager,
  onOpen,
}: {
  items: LeaveRecord[];
  manager: boolean;
  onOpen: (id: string) => void;
}) {
  return (
    <ul className="leave-request-list">
      {items.map((request) => (
        <li key={request.id}>
          <button
            type="button"
            className="leave-request"
            onClick={() => onOpen(request.id)}
          >
            <span className="leave-row-icon">
              <CalendarDays size={21} aria-hidden />
            </span>
            <span className="leave-row-period">
              {manager && <strong>{request.snapshot.legalName}</strong>}
              <span>{periodLabel(request.startDate, request.endDate)}</span>
              <small>{dayCount(request.days)}</small>
            </span>
            <Status status={request.status} />
            <ChevronRight className="leave-row-chevron" size={19} aria-hidden />
          </button>
        </li>
      ))}
    </ul>
  );
}

function daysInMonth(first: Date) {
  const date = new Date(first);
  date.setUTCMonth(date.getUTCMonth() + 1, 0);
  return date.getUTCDate();
}

function TeamCalendar({
  month,
  items,
  truncated,
  onOpen,
}: {
  month: string;
  items: LeaveRecord[];
  truncated: boolean;
  onOpen: (id: string) => void;
}) {
  const [selected, setSelected] = useState('');
  const first = new Date(month + '-01T00:00:00Z');
  const firstIndex = (first.getUTCDay() + 6) % 7;
  const lastDate = daysInMonth(first);
  const days = Array.from(
    { length: lastDate },
    (_, index) => month + '-' + String(index + 1).padStart(2, '0'),
  );
  const requestsByDay = new Map(days.map((day) => [day, [] as LeaveRecord[]]));
  for (const request of items) {
    if (request.status !== 'approved' && request.status !== 'submitted')
      continue;
    for (const day of request.snapshot.workingDates)
      requestsByDay.get(day)?.push(request);
  }
  const selectedItems = requestsByDay.get(selected) ?? [];
  return (
    <>
      {truncated && (
        <p className="leave-notice">
          Calendarul afișează primele {items.length} cereri din lună. Folosește
          lista pentru toate cererile.
        </p>
      )}
      <div className="leave-calendar-grid">
        {['Lu', 'Ma', 'Mi', 'Jo', 'Vi', 'Sâ', 'Du'].map((day) => (
          <span className="leave-calendar-weekday" key={day}>
            {day}
          </span>
        ))}
        {Array.from({ length: firstIndex }, (_, index) => (
          <span key={index} aria-hidden />
        ))}
        {days.map((day, index) => {
          const requests = requestsByDay.get(day) ?? [];
          const approved = requests.filter(
            (request) => request.status === 'approved',
          ).length;
          const awaiting = requests.length - approved;
          return (
            <button
              key={day}
              type="button"
              aria-label={
                dateLabel(day) +
                ', aprobate ' +
                approved +
                ', în așteptare ' +
                awaiting
              }
              aria-pressed={selected === day}
              className="leave-calendar-day"
              disabled={!requests.length}
              onClick={() => setSelected(day)}
            >
              <span>{index + 1}</span>
              <span className="leave-calendar-counts">
                {approved > 0 && <span data-status="approved">{approved}</span>}
                {awaiting > 0 && (
                  <span data-status="submitted">{awaiting}</span>
                )}
              </span>
            </button>
          );
        })}
      </div>
      <div className="leave-calendar-legend">
        <Status status="approved" />
        <Status status="submitted" />
      </div>
      {selectedItems.length > 0 && (
        <section className="leave-calendar-detail">
          <h3>{dateLabel(selected)}</h3>
          <RequestRows items={selectedItems} manager onOpen={onOpen} />
        </section>
      )}
    </>
  );
}

function LeaveHistory({
  owner,
  manager,
  scopeQuery,
  onOpen,
  view,
  updated,
}: {
  owner: string;
  manager: boolean;
  scopeQuery: string;
  onOpen: (id: string) => void;
  view: 'history' | 'calendar';
  updated: number;
}) {
  const today = currentMonth();
  const [year, setYear] = useState(today.slice(0, 4));
  const [month, setMonth] = useState(today);
  const [status, setStatus] = useState('');
  const [offset, setOffset] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const calendar = view === 'calendar';
  const limit = calendar ? 100 : 20;
  const filters = new URLSearchParams(scopeQuery);
  filters.set('limit', String(limit));
  filters.set('offset', String(offset));
  if (calendar) filters.set('month', month);
  else {
    if (year) filters.set('year', year);
    if (status) filters.set('status', status);
  }
  const { data, error } = useLeaveData<LeaveList>(
    'leave?' + filters,
    owner,
    refresh + updated,
  );
  const thisYear = Number(today.slice(0, 4));
  const years = Array.from(
    { length: Math.max(thisYear - 2023, 1) },
    (_, index) => thisYear + 1 - index,
  );
  function shiftMonth(delta: number) {
    const date = new Date(month + '-01T00:00:00Z');
    date.setUTCMonth(date.getUTCMonth() + delta);
    setMonth(iso(date).slice(0, 7));
  }
  return (
    <section className="leave-card leave-history" aria-busy={!data && !error}>
      <div className="leave-section-head">
        <div>
          <h2>
            {calendar
              ? 'Calendarul echipei'
              : manager
                ? 'Cererile echipei'
                : 'Cererile mele'}
          </h2>
          {data && !calendar && (
            <p>
              {data.total} {data.total === 1 ? 'cerere' : 'cereri'}
            </p>
          )}
        </div>
        <button
          type="button"
          className="secondary leave-icon-action"
          aria-label="Actualizează cererile"
          onClick={() => setRefresh((n) => n + 1)}
        >
          <RefreshCw size={18} aria-hidden />
        </button>
      </div>
      {calendar ? (
        <div className="leave-month">
          <button
            type="button"
            className="secondary leave-icon-action"
            aria-label="Luna anterioară"
            disabled={month <= '2025-01'}
            onClick={() => shiftMonth(-1)}
          >
            <ChevronLeft size={20} aria-hidden />
          </button>
          <div className="leave-month-fields">
            <select
              aria-label="Luna calendarului"
              value={month.slice(5)}
              onChange={(event) =>
                setMonth(month.slice(0, 5) + event.target.value)
              }
            >
              {calendarMonths.map(({ value, label }) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <select
              aria-label="Anul calendarului"
              value={month.slice(0, 4)}
              onChange={(event) =>
                setMonth(event.target.value + month.slice(4))
              }
            >
              {calendarYears.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            className="secondary leave-icon-action"
            aria-label="Luna următoare"
            disabled={month >= '2100-12'}
            onClick={() => shiftMonth(1)}
          >
            <ChevronRight size={20} aria-hidden />
          </button>
        </div>
      ) : (
        <div className="leave-filters">
          <label>
            Anul
            <select
              value={year}
              onChange={(event) => {
                setYear(event.target.value);
                setOffset(0);
              }}
            >
              <option value="">Toți anii</option>
              {years.map((value) => (
                <option value={value} key={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <label>
            Stare
            <select
              value={status}
              onChange={(event) => {
                setStatus(event.target.value);
                setOffset(0);
              }}
            >
              <option value="">Toate stările</option>
              {Object.entries(leaveStatus).map(([value, label]) => (
                <option value={value} key={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      <LeaveError>{error || ''}</LeaveError>
      {!data && !error && (
        <output className="leave-empty">Se încarcă cererile…</output>
      )}
      {data &&
        (calendar ? (
          <TeamCalendar
            key={month}
            month={month}
            items={data.items}
            truncated={data.hasMore}
            onOpen={onOpen}
          />
        ) : (
          <>
            {data.items.length ? (
              <RequestRows
                items={data.items}
                manager={manager}
                onOpen={onOpen}
              />
            ) : (
              <p className="leave-empty">Nicio cerere în perioada aleasă.</p>
            )}
            {(offset > 0 || data.hasMore) && (
              <nav aria-label="Pagini cereri" className="leave-pagination">
                <button
                  type="button"
                  className="secondary"
                  disabled={offset === 0}
                  onClick={() =>
                    setOffset((value) => Math.max(0, value - limit))
                  }
                >
                  Înapoi
                </button>
                <span>Pagina {Math.floor(offset / limit) + 1}</span>
                <button
                  type="button"
                  className="secondary"
                  disabled={!data.hasMore}
                  onClick={() => setOffset((value) => value + limit)}
                >
                  Înainte
                </button>
              </nav>
            )}
          </>
        ))}
    </section>
  );
}

function DateEditor({
  owner,
  request,
  onBack,
  onSaved,
}: {
  owner: string;
  request?: LeaveRecord;
  onBack: (refreshHistory: boolean) => void;
  onSaved: (request: LeaveRecord) => void;
}) {
  const [start, setStart] = useState(request?.startDate ?? '');
  const [end, setEnd] = useState(request?.endDate ?? '');
  const range = start && end;
  const valid = range && start <= end;
  const [preview, setPreview] = useState<{
    key: string;
    data?: LeaveCount;
    error?: string;
  }>();
  const [previewRun, setPreviewRun] = useState(0);
  const operation = useLeaveAction();
  const pendingCreate = useRef<{
    id: string;
    startDate: string;
    endDate: string;
  }>(null);
  const key = start + '|' + end + '|' + previewRun;
  useEffect(() => {
    if (!valid) return;
    const controller = new AbortController();
    const params = new URLSearchParams({ start, end });
    const timer = setTimeout(() => {
      void networkApi<LeaveCount>(
        'leave/calendar?' + params,
        'GET',
        undefined,
        controller.signal,
        undefined,
        owner,
      )
        .then((data) => {
          if (!controller.signal.aborted) setPreview({ key, data });
        })
        .catch((error) => {
          if (!controller.signal.aborted)
            setPreview({ key, error: errorMessage(error) });
        });
    }, 180);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [start, end, key, valid, owner]);

  const count = valid && preview?.key === key ? preview.data : undefined;
  const previewError =
    valid && preview?.key === key ? preview.error : undefined;
  function save(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!count) return;
    const period = { startDate: start, endDate: end };
    void operation.run(
      async (signal) => {
        const update = (draft: LeaveRecord) =>
          networkApi<LeaveResult>(
            requestPath(draft.id),
            'PUT',
            { ...period, revision: draft.revision },
            signal,
            undefined,
            owner,
          );
        if (request) return update(request);

        const previous = pendingCreate.current;
        const payload = previous ?? { id: crypto.randomUUID(), ...period };
        pendingCreate.current = payload;
        if (!previous) {
          try {
            return await networkApi<LeaveResult>(
              'leave',
              'POST',
              payload,
              signal,
              undefined,
              owner,
            );
          } catch (error) {
            // A validation response confirms that nothing was written.
            if (error instanceof ApiError && error.status === 400)
              pendingCreate.current = null;
            throw error;
          }
        }

        // Resolve the original attempt before changing its dates. If it has not
        // appeared yet, retry exactly the original payload with the same ID.
        const recovered = await networkApi<LeaveDetail>(
          requestPath(payload.id),
          'GET',
          undefined,
          signal,
          undefined,
          owner,
        ).catch((error) => {
          if (error instanceof ApiError && error.status === 404) return null;
          throw error;
        });
        const saved =
          recovered ??
          (await networkApi<LeaveResult>(
            'leave',
            'POST',
            payload,
            signal,
            undefined,
            owner,
          ));
        const draft = saved.request;
        if (
          draft.status !== 'draft' ||
          (draft.startDate === start && draft.endDate === end)
        )
          return { request: draft };
        return update(draft);
      },
      ({ request: saved }) => onSaved(saved),
    );
  }

  return (
    <section className="leave-card leave-editor">
      <button
        type="button"
        className="quiet leave-back"
        disabled={operation.busy}
        onClick={() => onBack(!!pendingCreate.current)}
      >
        <ArrowLeft size={18} aria-hidden /> Înapoi
      </button>
      <h2>{request ? 'Modifică perioada' : 'Cerere de concediu'}</h2>
      <form onSubmit={save} className="leave-form" aria-busy={operation.busy}>
        <div className="leave-date-fields">
          <label>
            Prima zi
            <input
              type="date"
              min="2025-01-01"
              max="2100-12-31"
              value={start}
              required
              disabled={operation.busy}
              onChange={(event) => {
                setStart(event.target.value);
                if (!end || end < event.target.value)
                  setEnd(event.target.value);
              }}
            />
          </label>
          <label>
            Ultima zi
            <input
              type="date"
              min={start || '2025-01-01'}
              max="2100-12-31"
              value={end}
              required
              disabled={operation.busy}
              onChange={(event) => setEnd(event.target.value)}
            />
          </label>
        </div>
        <div className="leave-period-summary" aria-live="polite">
          <CalendarDays size={23} aria-hidden />
          <div>
            <strong>
              {count
                ? dayCount(count.days)
                : valid && !previewError
                  ? 'Se calculează zilele…'
                  : 'Zile lucrătoare'}
            </strong>
            {count ? (
              <p>
                {count.excludedDates.length}{' '}
                {count.excludedDates.length === 1
                  ? 'zi exclusă'
                  : 'zile excluse'}{' '}
                (weekend și sărbători)
              </p>
            ) : (
              !range && <p>Alege prima și ultima zi de concediu.</p>
            )}
          </div>
        </div>
        <LeaveError>
          {range && !valid
            ? 'Ultima zi trebuie să fie la sau după prima zi.'
            : previewError || operation.error}
        </LeaveError>
        {previewError && (
          <button
            className="secondary"
            type="button"
            onClick={() => setPreviewRun((n) => n + 1)}
          >
            Recalculează
          </button>
        )}
        <button
          className="primary"
          disabled={!count || operation.busy}
          type="submit"
        >
          <Check size={18} aria-hidden />{' '}
          {operation.busy
            ? 'Se salvează…'
            : request
              ? 'Salvează perioada'
              : 'Salvează ciorna'}
        </button>
      </form>
    </section>
  );
}

function ProfileEditor({
  owner,
  profile,
  managers,
  onSaved,
}: {
  owner: string;
  profile: EmployeeProfile;
  managers: Manager[];
  onSaved: () => void;
}) {
  const [working, setWorking] = useState(profile);
  const linkedManagers = managers.filter((manager) =>
    manager.agentIds.includes(profile.userId),
  );
  const [approverEmails, setApproverEmails] = useState(() =>
    Object.fromEntries(
      linkedManagers.map((manager) => [
        manager.id,
        profile.approvers.find((approver) => approver.id === manager.id)
          ?.email ||
          (profile.approverId === manager.id ? profile.approverEmail : '') ||
          manager.email ||
          '',
      ]),
    ),
  );
  const [extraHolidays, setExtraHolidays] = useState(
    profile.extraHolidays.join('\n'),
  );
  const operation = useLeaveAction();
  function update<K extends keyof EmployeeProfile>(
    key: K,
    value: EmployeeProfile[K],
  ) {
    setWorking((old) => ({ ...old, [key]: value }));
  }
  function save(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const days = [
      ...new Set(extraHolidays.split(/[\s,]+/).filter(Boolean)),
    ].sort();
    if (days.some((day) => !/^\d{4}-\d{2}-\d{2}$/.test(day))) {
      operation.setError(
        'Introdu datele suplimentare în formatul AAAA-LL-ZZ, câte una pe rând.',
      );
      return;
    }
    const approvers = linkedManagers.map(({ id }) => ({
      id,
      email: approverEmails[id].trim(),
    }));
    if (!approvers.length || approvers.some((approver) => !approver.email))
      return;
    void operation.run(
      (signal) =>
        networkApi(
          'leave/profiles/' + encodeURIComponent(profile.userId),
          'PUT',
          { ...working, approvers, extraHolidays: days },
          signal,
          undefined,
          owner,
        ),
      onSaved,
    );
  }
  return (
    <form
      className="leave-form leave-profile-form"
      onSubmit={save}
      aria-busy={operation.busy}
    >
      <div className="leave-profile-fields">
        <label>
          Nume legal
          <input
            value={working.legalName}
            autoComplete="off"
            onChange={(event) => update('legalName', event.target.value)}
            disabled={operation.busy}
            required
          />
        </label>
        <label>
          Angajator
          <input
            value={working.employer}
            autoComplete="off"
            onChange={(event) => update('employer', event.target.value)}
            disabled={operation.busy}
            required
          />
        </label>
        <label>
          E-mail agent
          <input
            type="email"
            value={working.email}
            autoComplete="off"
            onChange={(event) => update('email', event.target.value)}
            disabled={operation.busy}
          />
        </label>
        <label>
          Calendar sărbători
          <select
            value={working.holidayCalendar}
            onChange={(event) =>
              update(
                'holidayCalendar',
                event.target.value === 'western' ? 'western' : 'orthodox',
              )
            }
            disabled={operation.busy}
          >
            <option value="orthodox">România · Paște ortodox</option>
            <option value="western">România · Paște occidental</option>
          </select>
        </label>
      </div>
      <fieldset className="leave-profile-approvers">
        <legend>Aprobatori asociați</legend>
        {linkedManagers.length ? (
          <>
            <p className="leave-help">
              Fiecare manager asociat poate aproba cererea și primește o copie a
              e-mailului.
            </p>
            <div className="leave-profile-fields">
              {linkedManagers.map((manager) => (
                <label key={manager.id}>
                  E-mail · {manager.name}
                  <input
                    type="email"
                    value={approverEmails[manager.id]}
                    onChange={(event) => {
                      const value = event.target.value;
                      setApproverEmails((old) => ({
                        ...old,
                        [manager.id]: value,
                      }));
                    }}
                    disabled={operation.busy}
                    required
                  />
                </label>
              ))}
            </div>
          </>
        ) : (
          <p className="leave-help">
            Asociază agentul unui manager în secțiunea Echipă pentru a salva
            profilul.
          </p>
        )}
      </fieldset>
      <label>
        Zile nelucrătoare suplimentare
        <textarea
          rows={3}
          placeholder="AAAA-LL-ZZ, câte una pe rând"
          value={extraHolidays}
          onChange={(event) => setExtraHolidays(event.target.value)}
          disabled={operation.busy}
        />
      </label>
      <label className="leave-checkbox">
        <input
          type="checkbox"
          checked={working.verified}
          onChange={(event) => update('verified', event.target.checked)}
          disabled={operation.busy}
        />
        Datele angajatului și de aprobare sunt verificate
      </label>
      <LeaveError>{operation.error}</LeaveError>
      <button
        className="primary"
        disabled={operation.busy || !linkedManagers.length}
        type="submit"
      >
        <Check size={18} aria-hidden />{' '}
        {operation.busy ? 'Se salvează…' : 'Salvează profilul'}
      </button>
    </form>
  );
}

function HrMailConfig({ owner, address }: { owner: string; address: string }) {
  const [to, setTo] = useState(address);
  const [notice, setNotice] = useState('');
  const operation = useLeaveAction();
  function save(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setNotice('');
    void operation.run(
      (signal) =>
        networkApi<{ to: string }>(
          'leave/config',
          'PUT',
          { to: to.trim() },
          signal,
          undefined,
          owner,
        ),
      (result) => {
        setTo(result.to);
        setNotice('Adresa HR a fost salvată.');
      },
    );
  }
  return (
    <form
      className="leave-surface leave-form"
      onSubmit={save}
      aria-busy={operation.busy}
    >
      <h3>Destinatarul cererilor</h3>
      <label>
        Adresa de e-mail HR
        <input
          type="email"
          value={to}
          onChange={(event) => setTo(event.target.value)}
          required
          disabled={operation.busy}
          maxLength={254}
        />
      </label>
      <LeaveError>{operation.error}</LeaveError>
      {notice && <output className="leave-notice">{notice}</output>}
      <button className="secondary" type="submit" disabled={operation.busy}>
        Salvează adresa HR
      </button>
    </form>
  );
}

function ProfileSettings({
  owner,
  scopeQuery,
  global,
}: {
  owner: string;
  scopeQuery: string;
  global: boolean;
}) {
  const [selected, setSelected] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [saved, setSaved] = useState(false);
  const { data, error } = useLeaveData<Profiles>(
    'leave/profiles' + (scopeQuery ? '?' + scopeQuery : ''),
    owner,
    refresh,
  );
  const profile = data?.profiles.find((item) => item.userId === selected);
  return (
    <section className="leave-card leave-profiles" aria-busy={!data && !error}>
      <h2>Profiluri de concediu</h2>
      <p className="leave-help">
        Verifică datele oficiale înainte ca agentul să creeze o cerere.
      </p>
      <LeaveError>{error || ''}</LeaveError>
      {error && (
        <button
          className="secondary"
          type="button"
          onClick={() => setRefresh((n) => n + 1)}
        >
          Reîncarcă profilurile
        </button>
      )}
      {!error && !data && (
        <output className="leave-empty">Se încarcă profilurile…</output>
      )}
      {global && data && (
        <HrMailConfig key={data.hrEmail} owner={owner} address={data.hrEmail} />
      )}
      {data &&
        (data.profiles.length ? (
          <label className="leave-profile-select">
            Agent
            <select
              value={selected}
              onChange={(event) => {
                setSelected(event.target.value);
                setSaved(false);
              }}
            >
              <option value="">Alege agentul</option>
              {data.profiles.map((item) => (
                <option key={item.userId} value={item.userId}>
                  {item.legalName || item.userId} ·{' '}
                  {item.verified ? 'verificat' : 'de verificat'}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <p className="leave-empty">
            Nu sunt profiluri disponibile în selecția curentă.
          </p>
        ))}
      {saved && (
        <output className="leave-notice">Profilul a fost salvat.</output>
      )}
      {profile && data && (
        <ProfileEditor
          key={profile.userId + '|' + profile.revision}
          owner={owner}
          profile={profile}
          managers={data.managers}
          onSaved={() => {
            setSaved(true);
            setRefresh((n) => n + 1);
          }}
        />
      )}
    </section>
  );
}

function MailPreview({
  mail,
  onDownload,
  busy,
}: {
  mail: LeaveMail;
  onDownload: () => void;
  busy: boolean;
}) {
  return (
    <section className="leave-surface leave-mail">
      <h3>
        <Mail size={19} aria-hidden /> E-mail de concediu
      </h3>
      <dl>
        <dt>Către</dt>
        <dd>{mail.to}</dd>
        <dt>CC</dt>
        <dd>{mail.cc.join(', ') || '—'}</dd>
        <dt>Subiect</dt>
        <dd>{mail.subject}</dd>
        <dt>Atașament</dt>
        <dd>{mail.filename}</dd>
      </dl>
      <details>
        <summary>Mesajul pregătit</summary>
        <p>{mail.body}</p>
      </details>
      <div className="leave-actions">
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={onDownload}
        >
          <Download size={18} aria-hidden /> Descarcă PDF-ul
        </button>
        {mail.mailto.startsWith('mailto:') && (
          <a className="primary" href={mail.mailto}>
            <Mail size={18} aria-hidden /> Deschide aplicația de mail
          </a>
        )}
      </div>
      <p className="leave-help">
        Descarcă PDF-ul, deschide e-mailul și atașează fișierul din Descărcări.
        Verifică destinatarii și trimite mesajul din aplicația de mail.
      </p>
    </section>
  );
}

const scanLimit = 4_000_000;
const unreadableScan =
  'Fotografia nu a putut fi deschisă. Alege o imagine JPEG sau PNG lizibilă.';

function scanDimensions(bytes: DataView, mime: string) {
  const size = bytes.byteLength;
  if (mime === 'image/png') {
    if (
      size < 33 ||
      bytes.getUint32(0) !== 0x89504e47 ||
      bytes.getUint32(4) !== 0x0d0a1a0a ||
      bytes.getUint32(8) !== 13 ||
      bytes.getUint32(12) !== 0x49484452
    )
      return;
    return { width: bytes.getUint32(16), height: bytes.getUint32(20) };
  }
  if (size < 4 || bytes.getUint16(0) !== 0xffd8) return;

  // JPEG metadata before Start of Scan is a series of length-prefixed segments.
  // Only Start of Frame carries the image size.
  let dimensions: { width: number; height: number } | undefined;
  for (let offset = 2; offset + 1 < size;) {
    if (bytes.getUint8(offset++) !== 0xff) return;
    while (offset < size && bytes.getUint8(offset) === 0xff) offset++;
    if (offset >= size) return;
    const marker = bytes.getUint8(offset++);
    if (marker === 0xda) return dimensions;
    if (marker === 0xd9 || marker === 0x00) return;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > size) return;
    const length = bytes.getUint16(offset);
    if (length < 2 || offset + length > size) return;
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      if (length < 8 || dimensions) return;
      dimensions = {
        width: bytes.getUint16(offset + 5),
        height: bytes.getUint16(offset + 3),
      };
    }
    offset += length;
  }
}

async function prepareScan(file: File) {
  if (file.size > 12_000_000)
    throw new Error('Alege o fotografie JPEG sau PNG de maximum 12 MB.');
  const dimensions = scanDimensions(
    new DataView(await file.arrayBuffer()),
    file.type,
  );
  if (!dimensions?.width || !dimensions.height) throw new Error(unreadableScan);
  const { width, height } = dimensions;
  if (width * height > 24_000_000 || Math.max(width, height) > 9000) {
    throw new Error(
      'Alege o fotografie de maximum 24 megapixeli și 9.000 px pe latura cea mai lungă.',
    );
  }

  const image = await createImageBitmap(file, {
    imageOrientation: 'from-image',
  }).catch(() => {
    throw new Error(unreadableScan);
  });
  try {
    const scale = Math.min(1, 2400 / Math.max(image.width, image.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('Fotografia nu a putut fi redimensionată.');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', 0.82),
    );
    if (!blob || blob.size > scanLimit)
      throw new Error('Alege o fotografie JPEG sau PNG de maximum 4 MB.');
    return new File([blob], 'cerere-semnata.jpg', { type: 'image/jpeg' });
  } finally {
    image.close();
  }
}

function LeaveRequestDetail({
  id,
  owner,
  manager,
  onBack,
  onChanged,
}: {
  id: string;
  owner: string;
  manager: boolean;
  onBack: () => void;
  onChanged: () => void;
}) {
  const [refresh, setRefresh] = useState(0);
  const [editing, setEditing] = useState(false);
  const [method, setMethod] = useState<'touch' | 'paper'>('touch');
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [scan, setScan] = useState<File | null>(null);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [note, setNote] = useState('');
  const [notice, setNotice] = useState('');
  const operation = useLeaveAction();
  const path = requestPath(id);
  const { data, error } = useLeaveData<LeaveDetail>(path, owner, refresh);
  const request = data?.request;
  const draft = request?.status === 'draft';
  const own = !!request && owner === request.agentId && !manager;
  const canCancel =
    request &&
    ((own && (draft || request.status === 'submitted')) ||
      (manager && request.canDecide && request.status === 'approved'));
  const canDecide =
    manager && request?.canDecide && request.status === 'submitted';
  const sendableMail =
    own &&
    request?.signedAt &&
    (request.status === 'submitted' || request.status === 'approved') &&
    data?.mail;
  const points = strokes.reduce((sum, stroke) => sum + stroke.length, 0);
  const signatureLength = strokes.reduce(
    (sum, stroke) =>
      sum +
      stroke
        .slice(1)
        .reduce(
          (length, point, index) =>
            length +
            Math.hypot(point.x - stroke[index].x, point.y - stroke[index].y),
          0,
        ),
    0,
  );
  const readySignature =
    points >= 5 && points <= signaturePointLimit && signatureLength >= 0.1;

  function refreshDetail(message = '') {
    setStrokes([]);
    setScan(null);
    setDecision(null);
    setNote('');
    setEditing(false);
    operation.setError('');
    setNotice(message);
    if (message) onChanged();
    setRefresh((value) => value + 1);
  }

  function download() {
    if (!request) return;
    const filename = draft
      ? 'Cerere-concediu-de-semnat.pdf'
      : data?.mail?.filename || 'Cerere-concediu-semnata.pdf';
    void operation.run(
      (signal) => leaveBinary(path + '/pdf', owner, signal),
      (result) => {
        if (result instanceof Blob) downloadPdf(result, filename);
      },
    );
  }

  function submit() {
    if (!request || !readySignature) return;
    void operation.run(
      (signal) =>
        networkApi<LeaveResult>(
          path + '/submit',
          'POST',
          { revision: request.revision, signature: strokes },
          signal,
          undefined,
          owner,
        ),
      () => refreshDetail('Cererea semnată a fost depusă.'),
    );
  }

  function upload() {
    if (!request || !scan) return;
    void operation.run(
      async (signal) => {
        const file = await prepareScan(scan);
        return leaveBinary(
          path + '/scan?revision=' + request.revision,
          owner,
          signal,
          file,
        );
      },
      () => refreshDetail('Cererea semnată a fost depusă.'),
    );
  }

  function updateDecision(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!request || !decision || (decision !== 'approved' && !note.trim()))
      return;
    const status = decision;
    void operation.run(
      (signal) =>
        networkApi<LeaveResult>(
          path + '/decision',
          'POST',
          { revision: request.revision, status, note: note.trim() },
          signal,
          undefined,
          owner,
        ),
      () =>
        refreshDetail(
          status === 'approved'
            ? 'Cererea a fost aprobată.'
            : status === 'rejected'
              ? 'Cererea a fost respinsă.'
              : 'Cererea a fost anulată.',
        ),
    );
  }

  if (request && editing)
    return (
      <DateEditor
        owner={owner}
        request={request}
        onSaved={() => refreshDetail('Perioada a fost actualizată.')}
        onBack={() => setEditing(false)}
      />
    );
  return (
    <section
      className="leave-card leave-detail"
      aria-busy={operation.busy || (!request && !error)}
    >
      <div className="leave-detail-nav">
        <button
          type="button"
          className="quiet leave-back"
          disabled={operation.busy}
          onClick={onBack}
        >
          <ArrowLeft size={18} aria-hidden /> Înapoi la concedii
        </button>
        <button
          type="button"
          className="secondary leave-icon-action"
          aria-label="Actualizează cererea"
          disabled={operation.busy}
          onClick={() => refreshDetail()}
        >
          <RefreshCw size={18} aria-hidden />
        </button>
      </div>
      {notice && <output className="leave-notice">{notice}</output>}
      <LeaveError>{error || operation.error}</LeaveError>
      {!request && !error && (
        <output className="leave-empty">Se încarcă cererea…</output>
      )}
      {request && data && (
        <>
          <div className="leave-section-head">
            <div>
              <h2>
                {manager ? request.snapshot.legalName : 'Cerere de concediu'}
              </h2>
              <p>{request.snapshot.employer}</p>
              <p>
                {request.snapshot.approvers?.length &&
                request.snapshot.approvers.length > 1
                  ? 'Aprobatori'
                  : 'Aprobator'}
                {' · '}
                {request.snapshot.approvers
                  ?.map((approver) => approver.name)
                  .join(', ') || request.snapshot.approverName}
              </p>
            </div>
            <Status status={request.status} />
          </div>
          <div className="leave-period-summary">
            <CalendarDays size={25} aria-hidden />
            <div>
              <strong>{periodLabel(request.startDate, request.endDate)}</strong>
              <p>{dayCount(request.days)}</p>
            </div>
            {own && draft && (
              <button
                type="button"
                className="secondary"
                disabled={operation.busy}
                onClick={() => {
                  setStrokes([]);
                  setScan(null);
                  setDecision(null);
                  setNote('');
                  setEditing(true);
                }}
              >
                Modifică perioada
              </button>
            )}
          </div>
          {request.decisionNote && (
            <div className="leave-notice">
              <strong>Motivul deciziei</strong>
              <p>{request.decisionNote}</p>
            </div>
          )}
          {own && draft && (
            <section className="leave-surface">
              <h3>Semnează cererea</h3>
              <div className="leave-switch" aria-label="Metodă de semnare">
                <button
                  type="button"
                  aria-pressed={method === 'touch'}
                  disabled={operation.busy}
                  onClick={() => {
                    setMethod('touch');
                    setScan(null);
                    operation.setError('');
                  }}
                >
                  <PenLine size={18} aria-hidden /> Pe tabletă
                </button>
                <button
                  type="button"
                  aria-pressed={method === 'paper'}
                  disabled={operation.busy}
                  onClick={() => {
                    setMethod('paper');
                    operation.setError('');
                  }}
                >
                  <FileText size={18} aria-hidden /> Pe hârtie
                </button>
              </div>
              {method === 'touch' ? (
                <>
                  <LeaveSignature
                    value={strokes}
                    onChange={setStrokes}
                    disabled={operation.busy}
                  />
                  {points > 0 && !readySignature && (
                    <p className="leave-help">
                      Completează semnătura înainte de depunere.
                    </p>
                  )}
                  <button
                    type="button"
                    className="primary"
                    disabled={!readySignature || operation.busy}
                    onClick={submit}
                  >
                    <Check size={18} aria-hidden /> Semnează și depune
                  </button>
                </>
              ) : (
                <>
                  <p className="leave-help">
                    Descarcă formularul, imprimă-l și semnează-l. Fotografiază
                    pagina întreagă, cu textul și semnătura lizibile.
                  </p>
                  <button
                    type="button"
                    className="secondary"
                    disabled={operation.busy}
                    onClick={download}
                  >
                    <Download size={18} aria-hidden /> Descarcă PDF-ul pentru
                    imprimare
                  </button>
                  <label>
                    Fotografia cererii semnate (JPEG sau PNG)
                    <input
                      type="file"
                      accept="image/jpeg,image/png"
                      disabled={operation.busy}
                      onChange={(event) => {
                        const file = event.currentTarget.files?.[0] || null;
                        if (
                          file &&
                          file.type !== 'image/jpeg' &&
                          file.type !== 'image/png'
                        ) {
                          operation.setError('Alege o imagine JPEG sau PNG.');
                          event.currentTarget.value = '';
                          setScan(null);
                        } else {
                          operation.setError('');
                          setScan(file);
                        }
                      }}
                    />
                  </label>
                  <button
                    type="button"
                    className="primary"
                    disabled={!scan || operation.busy}
                    onClick={upload}
                  >
                    <Upload size={18} aria-hidden /> Încarcă și depune
                  </button>
                </>
              )}
            </section>
          )}
          {sendableMail && (
            <MailPreview
              mail={sendableMail}
              onDownload={download}
              busy={operation.busy}
            />
          )}
          {request.signedAt && !sendableMail && (
            <button
              type="button"
              className="secondary"
              disabled={operation.busy}
              onClick={download}
            >
              <Download size={18} aria-hidden /> Descarcă PDF-ul semnat
            </button>
          )}
          {(canDecide || canCancel) && (
            <section className="leave-surface">
              <h3>{canDecide ? 'Decizia de concediu' : 'Anularea cererii'}</h3>
              <div className="leave-actions">
                {canDecide && (
                  <button
                    type="button"
                    className="primary"
                    disabled={operation.busy}
                    onClick={() => {
                      setDecision('approved');
                      setNote('');
                    }}
                  >
                    Aprobă
                  </button>
                )}
                {canDecide && (
                  <button
                    type="button"
                    className="danger"
                    disabled={operation.busy}
                    onClick={() => {
                      setDecision('rejected');
                      setNote('');
                    }}
                  >
                    Respinge
                  </button>
                )}
                {canCancel && (
                  <button
                    type="button"
                    className="danger"
                    disabled={operation.busy}
                    onClick={() => {
                      setDecision('cancelled');
                      setNote('');
                    }}
                  >
                    Anulează cererea
                  </button>
                )}
              </div>
              {decision && (
                <form className="leave-form" onSubmit={updateDecision}>
                  <label>
                    {decision === 'approved'
                      ? 'Observație (opțional)'
                      : 'Motiv (obligatoriu)'}
                    <textarea
                      rows={3}
                      value={note}
                      maxLength={1000}
                      disabled={operation.busy}
                      required={decision !== 'approved'}
                      onChange={(event) => setNote(event.target.value)}
                    />
                  </label>
                  <div className="leave-actions">
                    <button
                      type="submit"
                      className={decision === 'approved' ? 'primary' : 'danger'}
                      disabled={
                        operation.busy ||
                        (decision !== 'approved' && !note.trim())
                      }
                    >
                      {decision === 'approved'
                        ? 'Confirmă aprobarea'
                        : decision === 'rejected'
                          ? 'Confirmă respingerea'
                          : 'Confirmă anularea'}
                    </button>
                    <button
                      type="button"
                      className="quiet"
                      disabled={operation.busy}
                      onClick={() => {
                        setDecision(null);
                        setNote('');
                      }}
                    >
                      Înapoi
                    </button>
                  </div>
                </form>
              )}
            </section>
          )}
          {data.events.length > 0 && (
            <section className="leave-surface">
              <h3>Istoricul cererii</h3>
              <ul className="leave-events">
                {data.events.map((event) => (
                  <li key={event.id}>
                    <div>
                      <strong>
                        {eventLabels[event.action] || event.action}
                      </strong>
                      <small>{event.actorName}</small>
                      {event.note && <small>{event.note}</small>}
                    </div>
                    <time dateTime={event.createdAt}>
                      {eventDate.format(new Date(event.createdAt))}
                    </time>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </section>
  );
}

type WorkspaceProps = {
  user: User;
  scopeQuery?: string;
  focusId?: string;
  onFocusConsumed?: () => void;
};

function Workspace({
  user,
  scopeQuery = '',
  focusId,
  onFocusConsumed,
}: WorkspaceProps) {
  const manager = user.role === 'manager';
  const [view, setView] = useState<View>('history');
  const [selected, setSelected] = useState(focusId ?? '');
  useEffect(() => {
    if (focusId) onFocusConsumed?.();
  }, [focusId, onFocusConsumed]);
  const [create, setCreate] = useState(false);
  const [profileRefresh, setProfileRefresh] = useState(0);
  const [updated, setUpdated] = useState(0);
  const historyRef = useRef<HTMLElement>(null);
  const views = [
    { id: 'history' as const, label: 'Cereri', icon: ClipboardList },
    { id: 'calendar' as const, label: 'Calendar', icon: CalendarDays },
    { id: 'profiles' as const, label: 'Profiluri', icon: Settings2 },
  ];
  const moveFocus = () =>
    requestAnimationFrame(() => historyRef.current?.focus());
  const jumpToHistory = () => {
    setSelected('');
    setCreate(false);
    moveFocus();
  };
  const jumpToRequest = (id: string) => {
    setCreate(false);
    setSelected(id);
    moveFocus();
  };
  return (
    <div className="leave-workspace">
      <header className="leave-header" ref={historyRef} tabIndex={-1}>
        <div className="leave-heading-icon">
          <CalendarDays size={25} aria-hidden />
        </div>
        <div className="leave-heading-title">
          <h1>Concedii</h1>
          <p>
            {manager
              ? 'Cererile și perioadele de concediu ale echipei.'
              : 'Depune cereri și urmărește starea lor.'}
          </p>
        </div>
        {!manager && !selected && !create && (
          <AgentStart
            owner={user.id}
            refresh={profileRefresh}
            onRefresh={() => setProfileRefresh((n) => n + 1)}
            onCreate={() => {
              setCreate(true);
              moveFocus();
            }}
          />
        )}
      </header>
      {manager && !selected && (
        <nav
          className="leave-switch leave-main-nav"
          aria-label="Secțiuni concedii"
        >
          {views.map(({ id, label, icon: Icon }) => (
            <button
              type="button"
              aria-pressed={view === id}
              key={id}
              onClick={() => setView(id)}
            >
              <Icon size={18} aria-hidden /> {label}
            </button>
          ))}
        </nav>
      )}
      {selected && (
        <LeaveRequestDetail
          key={selected}
          id={selected}
          owner={user.id}
          manager={manager}
          onBack={jumpToHistory}
          onChanged={() => setUpdated((n) => n + 1)}
        />
      )}
      {create && (
        <DateEditor
          owner={user.id}
          onBack={(refreshHistory) => {
            jumpToHistory();
            if (refreshHistory) setUpdated((n) => n + 1);
          }}
          onSaved={(request) => {
            jumpToRequest(request.id);
            setUpdated((n) => n + 1);
          }}
        />
      )}
      {view === 'profiles' && manager ? (
        <ProfileSettings
          owner={user.id}
          scopeQuery={scopeQuery}
          global={user.managerScope === 'global'}
        />
      ) : (
        <div hidden={!!selected || create}>
          <LeaveHistory
            key={view}
            owner={user.id}
            manager={manager}
            scopeQuery={manager ? scopeQuery : ''}
            onOpen={jumpToRequest}
            view={view === 'calendar' ? 'calendar' : 'history'}
            updated={updated}
          />
        </div>
      )}
    </div>
  );
}

function AgentStart({
  owner,
  refresh,
  onRefresh,
  onCreate,
}: {
  owner: string;
  refresh: number;
  onRefresh: () => void;
  onCreate: () => void;
}) {
  const { data, error } = useLeaveData<Profiles>(
    'leave/profiles',
    owner,
    refresh,
  );
  const verified = profileReady(
    data?.profiles.find((profile) => profile.userId === owner),
  );
  const ready = verified && !!data?.hrEmail;
  return (
    <>
      <div className="leave-header-actions">
        <button
          type="button"
          className="primary"
          onClick={onCreate}
          disabled={!ready}
        >
          <Plus size={20} aria-hidden /> Cerere nouă
        </button>
      </div>
      {error && (
        <div className="leave-header-notice">
          <LeaveError>{error}</LeaveError>
          <button className="secondary" type="button" onClick={onRefresh}>
            Reîncarcă profilul
          </button>
        </div>
      )}
      {data && !ready && (
        <p className="leave-header-notice">
          {verified
            ? 'Cere managerului să configureze adresa HR pentru cererile de concediu.'
            : 'Cere managerului să verifice profilul tău de concediu pentru a putea depune cereri.'}{' '}
          <button
            className="quiet leave-compact"
            type="button"
            onClick={onRefresh}
          >
            Verifică din nou
          </button>
        </p>
      )}
      {!data && !error && (
        <output className="leave-header-notice">
          Se verifică profilul de concediu…
        </output>
      )}
    </>
  );
}

export function LeaveWorkspace(props: WorkspaceProps) {
  return (
    <Workspace key={[props.user.id, props.scopeQuery].join('|')} {...props} />
  );
}
