'use client';

import { useRef, useState, type PointerEvent } from 'react';
import { RotateCcw } from 'lucide-react';
import type { Stroke } from '@/lib/leave-types';

const padWidth = 600;
const padHeight = 220;
export const signaturePointLimit = 5000;
const strokeLimit = 100;
const clamp = (value: number) => Math.max(0, Math.min(1, value));

function point(event: PointerEvent<SVGSVGElement>) {
  const rect = event.currentTarget.getBoundingClientRect();
  return {
    x: clamp((event.clientX - rect.left) / rect.width),
    y: clamp((event.clientY - rect.top) / rect.height),
  };
}

export function LeaveSignature({
  value,
  onChange,
  disabled,
}: {
  value: Stroke[];
  onChange: (strokes: Stroke[]) => void;
  disabled?: boolean;
}) {
  const pointerId = useRef<number | null>(null);
  const active = useRef<Stroke>([]);
  const [preview, setPreview] = useState<Stroke>([]);
  const remaining =
    signaturePointLimit - value.reduce((sum, stroke) => sum + stroke.length, 0);
  const atLimit =
    remaining < 2 || value.length >= strokeLimit || preview.length >= remaining;

  function start(event: PointerEvent<SVGSVGElement>) {
    if (disabled || event.button !== 0 || pointerId.current !== null || atLimit)
      return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    pointerId.current = event.pointerId;
    active.current = [point(event)];
    setPreview(active.current);
  }

  function move(event: PointerEvent<SVGSVGElement>) {
    if (
      event.pointerId !== pointerId.current ||
      active.current.length >= remaining
    )
      return;
    const next = point(event);
    const previous = active.current[active.current.length - 1];
    if (Math.hypot(next.x - previous.x, next.y - previous.y) < 0.0015) return;
    active.current = [...active.current, next];
    setPreview(active.current);
  }

  function finish(event: PointerEvent<SVGSVGElement>, discard = false) {
    if (event.pointerId !== pointerId.current) return;
    const stroke = active.current;
    pointerId.current = null;
    active.current = [];
    setPreview([]);
    if (!discard && stroke.length > 1) onChange([...value, stroke]);
  }

  return (
    <div className="leave-signature">
      <p className="sr-only">
        Semnează cu degetul sau cu stylusul. Pentru depunere cu tastatura, alege
        Pe hârtie.
      </p>
      <div className="leave-signature-heading">
        <strong>Semnătura olografă</strong>
        <button
          type="button"
          className="quiet leave-compact"
          disabled={disabled || !value.length || !!preview.length}
          onClick={() => onChange([])}
        >
          <RotateCcw size={17} aria-hidden /> Șterge
        </button>
      </div>
      <div className="leave-signature-surface">
        <svg
          viewBox={`0 0 ${padWidth} ${padHeight}`}
          preserveAspectRatio="none"
          aria-label="Zonă pentru semnătură"
          onPointerDown={start}
          onPointerMove={move}
          onPointerUp={finish}
          onPointerCancel={(event) => finish(event, true)}
          onLostPointerCapture={(event) => finish(event, true)}
        >
          {[...value, preview]
            .filter((stroke) => stroke.length > 1)
            .map((stroke, index) => (
              <polyline
                key={index}
                points={stroke
                  .map(({ x, y }) => `${x * padWidth},${y * padHeight}`)
                  .join(' ')}
                fill="none"
                stroke="currentColor"
                strokeWidth="2.75"
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
            ))}
        </svg>
        {!value.length && !preview.length && (
          <span>Semnează cu degetul sau cu stylusul</span>
        )}
      </div>
      {atLimit && (
        <output className="leave-help">
          Ai ajuns la limita semnăturii. Pentru a semna din nou, apasă Șterge.
        </output>
      )}
    </div>
  );
}
