import { useCallback, useState } from 'react';
import { jpCore } from './client';
import type { FuriToken } from './worker';
import type { LookupResult } from '../dictionary/types';

export interface LookupState {
  result: LookupResult | null;
  loading: boolean;
  anchor: DOMRect | null;
  error: string | null;
}

/**
 * Universal lookup controller (build plan §3.5): any surface (reader, RSS, test page) calls
 * `lookupToken`/`lookupTerm`; one shared popup renders the result. Reused everywhere so
 * "dictionary across the board" is a single service, not per-page code.
 */
export function useLookup() {
  const [state, setState] = useState<LookupState>({
    result: null,
    loading: false,
    anchor: null,
    error: null,
  });

  const lookupTerm = useCallback(async (term: string, anchor: DOMRect, basicForm?: string) => {
    setState({ result: null, loading: true, anchor, error: null });
    try {
      const result = await jpCore.lookup(term, basicForm);
      setState({ result, loading: false, anchor, error: null });
    } catch (e) {
      setState({
        result: null,
        loading: false,
        anchor,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }, []);

  const lookupToken = useCallback(
    (token: FuriToken, anchor: DOMRect) => lookupTerm(token.surface, anchor, token.basic),
    [lookupTerm],
  );

  const close = useCallback(() => {
    setState({ result: null, loading: false, anchor: null, error: null });
  }, []);

  const isOpen = state.anchor !== null;

  return { ...state, isOpen, lookupTerm, lookupToken, close };
}
