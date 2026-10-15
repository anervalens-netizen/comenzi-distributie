'use client';
import {useEffect,useRef} from 'react';
import {startUsageTracking} from '@/lib/usage-client';
import {USAGE_SCREENS} from '@/lib/usage-model';
export function UsageTracker({owner,screen}:{owner:string;screen:string}){
  const current=useRef(screen);
  useEffect(()=>{current.current=USAGE_SCREENS.includes(screen as typeof USAGE_SCREENS[number])?screen:'orders';},[screen]);
  useEffect(()=>{try{return startUsageTracking(owner,()=>current.current);}catch{return;}},[owner]);
  return null;
}
