'use client';

import { Bell, CalendarDays, Check, CheckCheck, ChevronLeft, ChevronRight, Package, Radio, Store } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ComponentType } from 'react';
import { PushNotifications } from '@/components/push-notifications';
import { errorMessage, networkApi } from '@/lib/client-api';
import type { NotificationFeed, NotificationItem } from '@/lib/leave-types';

const FEED_CHANGED = 'mobiup-notification-feed';
const PAGE_SIZE = 30;
const categories = [
  { id: 'all', label: 'Toate' },
  { id: 'leave', label: 'Concedii', icon: CalendarDays },
  { id: 'partner', label: 'Parteneri', icon: Store },
  { id: 'activation', label: 'Activări', icon: Radio },
  { id: 'order', label: 'Comenzi', icon: Package },
];
type TargetProps = {
  onOpenTarget: (item: NotificationItem) => void;
  canOpenTarget?: boolean;
};
type RowProps = TargetProps & {
  item: NotificationItem;
  busy: boolean;
  onRead: (id: string) => void;
};

function isNotificationItem(value: unknown): value is NotificationItem {
  if (!value || typeof value !== 'object') return false;
  const { id, category, title, body, targetType, targetId, createdAt, readAt } = value as Partial<NotificationItem>;
  return typeof id === 'string' && typeof category === 'string' && typeof title === 'string' &&
    typeof body === 'string' && typeof targetType === 'string' && typeof targetId === 'string' &&
    typeof createdAt === 'string' && (readAt === null || typeof readAt === 'string');
}

async function requestFeed(path: string, method: 'GET' | 'POST', body: unknown, signal: AbortSignal): Promise<NotificationFeed> {
  const value = await networkApi<Partial<NotificationFeed> | null>(path, method, body, signal);
  if (!value || !Array.isArray(value.items) || !value.items.every(isNotificationItem) ||
    typeof value.unread !== 'number' || !Number.isSafeInteger(value.unread) || value.unread < 0 ||
    typeof value.categoryUnread !== 'number' || !Number.isSafeInteger(value.categoryUnread) ||
    value.categoryUnread < 0 || value.categoryUnread > value.unread ||
    typeof value.total !== 'number' || !Number.isSafeInteger(value.total) || value.total < 0 ||
    typeof value.hasMore !== 'boolean') {
    throw new Error('Serverul a trimis notificări într-un format invalid.');
  }
  const { items, unread, categoryUnread, total, hasMore } = value;
  return { items, unread, categoryUnread, total, hasMore };
}

const dateFormat = new Intl.DateTimeFormat('ro-RO', {
  dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Bucharest',
});

function NotificationRow({ item, busy, canOpenTarget = true, onOpenTarget, onRead }: RowProps) {
  const category = categories.find(entry => entry.id === item.category);
  const Icon: ComponentType<{ size?: number }> = category?.icon ?? Bell;
  const date = new Date(item.createdAt);
  const label = Number.isNaN(date.getTime()) ? '' : dateFormat.format(date);

  return <li className={'notification-row'+(item.readAt ? '' : ' notification-row-unread')}>
    <span className="notification-icon" aria-hidden="true"><Icon size={17}/></span>
    <div className="notification-row-copy">
      <div className="notification-row-meta">
        {category && <span>{category.label}</span>}
        {label && <time dateTime={item.createdAt}>{label}</time>}
        {!item.readAt && <span className="notification-unread-label">Necitită</span>}
      </div>
      <strong>{item.title}</strong>
      {item.body && <p>{item.body}</p>}
    </div>
    <div className="notification-row-actions">
      {item.targetType && item.targetId &&
        <button type="button" className="secondary" disabled={busy || !canOpenTarget} onClick={() => onOpenTarget(item)}>Deschide</button>}
      {!item.readAt &&
        <button type="button" className="icon-button" disabled={busy} title="Marchează ca citită"
          aria-label={'Marchează ca citită: '+item.title} onClick={() => onRead(item.id)}><Check size={17}/></button>}
    </div>
  </li>;
}

type BellProps = {
  onOpenCenter: () => void;
  active: boolean;
  blocked: boolean;
};

export function NotificationBell({ onOpenCenter, active, blocked }: BellProps) {
  const [unread, setUnread] = useState(0);
  const pendingRead = useRef<AbortController>(null);
  const refresh = useCallback(async () => {
    pendingRead.current?.abort();
    const controller = new AbortController();
    pendingRead.current = controller;
    try {
      const next = await requestFeed('notifications/feed?limit=5', 'GET', undefined, controller.signal);
      if (!controller.signal.aborted) setUnread(next.unread);
    } catch {
      // Keep the last verified badge. The full center reports feed errors and supports retry.
    }
  }, []);
  useEffect(() => {
    const load = () => {
      if (document.visibilityState !== 'hidden') void refresh();
    };
    load();
    const interval = window.setInterval(load, 60_000);
    window.addEventListener('focus', load);
    window.addEventListener('online', load);
    window.addEventListener(FEED_CHANGED, load);
    document.addEventListener('visibilitychange', load);
    return () => {
      pendingRead.current?.abort();
      window.clearInterval(interval);
      window.removeEventListener('focus', load);
      window.removeEventListener('online', load);
      window.removeEventListener(FEED_CHANGED, load);
      document.removeEventListener('visibilitychange', load);
    };
  }, [refresh]);

  return <button type="button" className="icon-button request-bell" title="Notificări"
    aria-label={unread ? 'Notificări necitite '+unread : 'Notificări'}
    aria-current={active ? 'page' : undefined} disabled={blocked} onClick={onOpenCenter}>
    <Bell size={20} aria-hidden="true"/>
    {unread > 0 && <span className="request-count" aria-hidden="true">{unread > 99 ? '99+' : unread}</span>}
  </button>;
}

export function NotificationCenter({ onOpenTarget, canOpenTarget = true }: TargetProps) {
  const [category, setCategory] = useState('all');
  const [unread, setUnread] = useState(false);
  const [offset, setOffset] = useState(0);
  const [feed, setFeed] = useState<{ path: string; value: NotificationFeed }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const pendingRead = useRef<AbortController>(null);
  const pendingAction = useRef<AbortController>(null);

  const path = `notifications/feed?category=${category}&unread=${Number(unread)}&offset=${offset}`;
  const current = feed?.path === path ? feed.value : undefined;

  useEffect(() => {
    const controller = new AbortController();
    pendingRead.current = controller;
    void requestFeed(path, 'GET', undefined, controller.signal)
      .then(value => {
        if (!controller.signal.aborted) setFeed({ path, value });
      }).catch(error => {
        if (!controller.signal.aborted) setError(errorMessage(error));
      });
    return () => controller.abort();
  }, [path, retry]);

  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
    return () => pendingAction.current?.abort();
  }, []);

  async function act(selection: { ids: string[] } | { all: true }, navigate?: NotificationItem) {
    if (busy) return;
    const controller = new AbortController();
    pendingAction.current = controller;
    setBusy(true);
    setError('');
    try {
      const value = await requestFeed('notifications/read', 'POST', { ...selection, category, unread }, controller.signal);
      if (controller.signal.aborted) return;
      pendingRead.current?.abort();
      if (offset) {
        setOffset(0);
      } else {
        setFeed({ path, value });
      }
      window.dispatchEvent(new Event(FEED_CHANGED));
    } catch (error) {
      if (!controller.signal.aborted) setError(errorMessage(error));
      return;
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
    if (navigate) onOpenTarget(navigate);
  }

  function move(next: number) {
    setError('');
    setOffset(next);
  }
  function open(item: NotificationItem) {
    if (item.readAt) onOpenTarget(item);
    else void act({ ids: [item.id] }, item);
  }

  return <div className="notification-center">
    <section className="panel notification-panel" aria-labelledby="notification-heading">
      <div className="section-heading">
        <Bell size={22}/>
        <div><h1 ref={heading} id="notification-heading" tabIndex={-1}>Notificări</h1><p>{current
          ? current.categoryUnread+' necitite'+(category==='all' ? '' : ' în această categorie')
          : 'Mesajele din contul tău'}</p></div>
      </div>
      <div className="notification-controls">
        <fieldset className="notification-categories"><legend className="sr-only">Categorii de notificări</legend>
          {categories.map(entry => <button type="button" key={entry.id} className="secondary"
            aria-pressed={category === entry.id} disabled={busy}
            onClick={() => { setCategory(entry.id); move(0); }}>{entry.label}</button>)}
        </fieldset>
        <div className="notification-filter-actions">
          <label className="notification-filter"><input type="checkbox" checked={unread} disabled={busy}
            onChange={event => { setUnread(event.target.checked); move(0); }}/> Doar necitite</label>
          <button type="button" className="secondary" disabled={busy || !current?.categoryUnread}
            onClick={() => void act({ all: true })}><CheckCheck size={17}/> Marchează toate ca citite</button>
        </div>
      </div>
      {error && <div className="error-banner" role="alert">{error} <button type="button" className="quiet"
        onClick={() => { setError(''); setRetry(value => value + 1); }}>Reîncarcă</button></div>}
      {current?.items.length
        ? <ul className="notification-list">
          {current.items.map(item => <NotificationRow key={item.id} item={item} busy={busy} canOpenTarget={canOpenTarget}
            onOpenTarget={open} onRead={id => void act({ ids: [id] })}/>)}
        </ul>
        : !error && <output className="notification-empty">{current ? (unread ? 'Nu există notificări necitite în această categorie.' : 'Nu există notificări în această categorie.') : 'Se încarcă notificările…'}</output>}
      {current && (offset > 0 || current.hasMore) && <div className="notification-pagination">
        <button type="button" className="secondary" disabled={!offset || busy}
          onClick={() => move(Math.max(0, offset - PAGE_SIZE))}><ChevronLeft size={17}/> Înapoi</button>
        <span>{Math.floor(offset / PAGE_SIZE) + 1} / {Math.max(1, Math.ceil(current.total / PAGE_SIZE))}</span>
        <button type="button" className="secondary" disabled={!current.hasMore || busy}
          onClick={() => move(offset + PAGE_SIZE)}>Înainte <ChevronRight size={17}/></button>
      </div>}
    </section>
    <PushNotifications/>
  </div>;
}
