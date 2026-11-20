import Image from 'next/image';
import { cn } from '@/lib/utils';

type AiHaloOrbSize = 'xs' | 'sm' | 'md' | 'lg';
export type AiHaloOrbState = 'idle' | 'running' | 'unavailable';

const sizeClass: Record<AiHaloOrbSize, string> = {
  xs: 'size-7',
  sm: 'size-8',
  md: 'size-11',
  lg: 'size-14',
};

export function AiHaloOrb({
  size = 'md',
  state = 'idle',
  className,
  centerLabel = false,
}: {
  size?: AiHaloOrbSize;
  state?: AiHaloOrbState;
  className?: string;
  centerLabel?: boolean;
}) {
  const running = state === 'running';
  const unavailable = state === 'unavailable';

  return (
    <span
      data-ai-halo-orb
      data-state={state}
      className={cn(
        'relative isolate inline-flex shrink-0 items-center justify-center rounded-full',
        sizeClass[size],
        className,
      )}
      aria-hidden="true"
    >
      <Image
        width={56}
        height={56}
        unoptimized
        src="/unihub-ai-halo.webp"
        alt=""
        draggable={false}
        className={cn(
          'size-full select-none object-contain transition-[transform,filter,opacity] duration-500',
          running && 'motion-safe:animate-pulse drop-shadow-[0_0_10px_rgba(103,232,249,0.45)]',
          unavailable
            ? 'grayscale opacity-35'
            : 'opacity-100 group-hover:scale-[1.03]',
        )}
      />
      {centerLabel && (
        <span
          data-ai-halo-center-label
          className="pointer-events-none absolute inset-0 z-10 flex select-none items-center justify-center text-[8px] font-bold leading-none tracking-[-0.04em] text-white/90 drop-shadow-[0_0_3px_rgba(103,232,249,0.9)]"
        >
          AI
        </span>
      )}
    </span>
  );
}
