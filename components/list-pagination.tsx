'use client';
import { useRef, useState } from 'react';
import { listPage } from '@/lib/list-pagination';
import './list-pagination.css';

// Reset during render so a changed filter never commits the previous page first.
export function useListPage(count: number, resetKey: string) {
  const [selection, setSelection] = useState({ key: resetKey, page: 0 });
  if (selection.key !== resetKey) setSelection({ key: resetKey, page: 0 });
  const range = listPage(count, selection.key === resetKey ? selection.page : 0);
  return {
    ...range,
    setPage: (page: number) => setSelection({ key: resetKey, page: listPage(count, page).page }),
  };
}

export function ListPagination({ count, page, pages, start, end, onPage, label, disabled=false, note }: {
  count: number;
  page: number;
  pages: number;
  start: number;
  end: number;
  onPage: (page: number) => void;
  label: string;
  disabled?: boolean;
  note?: string;
}) {
  const previous = useRef<HTMLButtonElement>(null), next = useRef<HTMLButtonElement>(null);
  function navigate(targetPage: number, button: HTMLButtonElement) {
    const hadFocus = document.activeElement === button;
    onPage(targetPage);
    // A control that becomes disabled at a boundary cannot retain keyboard
    // focus reliably. Keep it in this navigation instead of losing it to body.
    if (hadFocus) requestAnimationFrame(() => {
      if (button.disabled) (targetPage === 0 ? next.current : previous.current)?.focus();
    });
  }
  if (!count) return null;
  return <nav className="list-pagination" aria-label={label}>
    <output aria-live="polite" aria-atomic="true">
      {start + 1}–{end} din {count}{pages > 1 && <span> · Pagina {page + 1} din {pages}</span>}{note&&<span> · {note}</span>}
    </output>
    {pages > 1 && <div>
      <button ref={previous} type="button" className="secondary" disabled={disabled||page === 0} onClick={event => navigate(page - 1, event.currentTarget)}>Anterior</button>
      <button ref={next} type="button" className="secondary" disabled={disabled||page === pages - 1} onClick={event => navigate(page + 1, event.currentTarget)}>Următor</button>
    </div>}
  </nav>;
}
