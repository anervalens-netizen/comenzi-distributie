import { createContext, useContext } from 'react';
import type { createAiApi } from './api';

export const AiApiContext = createContext<ReturnType<typeof createAiApi> | null>(null);

export function useAiApi() {
  const api = useContext(AiApiContext);
  if (!api) throw new Error('AI Comenzi API provider is missing');
  return api;
}
