'use client';
import { useEffect } from 'react';
export function PwaInstall() {
  useEffect(() => {
    const suppress = (event: Event) => event.preventDefault();
    window.addEventListener('beforeinstallprompt', suppress);
    if ('serviceWorker' in navigator)
      void navigator.serviceWorker.register('/sw.js').catch(() => {});
    return () => window.removeEventListener('beforeinstallprompt', suppress);
  }, []);
  return null;
}
