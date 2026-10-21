import { useQuery, type Query } from '@tanstack/react-query';
import { contactApi } from '../services/api';

const DAY_MS = 24 * 60 * 60 * 1000;
// The route answers null both when the account knows no phone for the id and when the lookup failed in the engine,
// and the two look alike, so a null is not held for the day a phone is.
const NULL_STALE_MS = 60 * 1000;

/**
 * Lazily resolve a contact id (e.g. an @lid privacy id) to its phone number (MSISDN digits) for
 * one (sessionId, contactId). Returns null when the engine can't map it — the caller keeps its
 * fallback label in that case. An @lid ↔ phone mapping is stable, so a phone is cached for a
 * day, a null for a minute; `retry: false` keeps an unmappable id from spamming the server.
 *
 * Call it with `enabled` inputs only when the cheap local formatting already failed
 * (formatPhoneForDisplay returned null) — normal @c.us chats never need the engine round-trip.
 */
export function useResolvedPhone(sessionId: string | undefined, contactId: string | undefined) {
  return useQuery<string | null, Error>({
    ...resolvedPhoneQuery(sessionId!, contactId!),
    enabled: Boolean(sessionId && contactId),
    gcTime: 60 * 60 * 1000,
    retry: false,
  });
}

/** The query behind {@link useResolvedPhone}, for a caller that asks about several ids at once (fetchQuery). */
export function resolvedPhoneQuery(sessionId: string, contactId: string) {
  return {
    queryKey: ['resolvedPhone', sessionId, contactId] as const,
    queryFn: () => contactApi.resolvePhone(sessionId, contactId).then(r => r.phone),
    // lid→phone mappings don't churn, so a phone is held for the day; a null is not (see NULL_STALE_MS).
    staleTime: (query: Query<string | null, Error>) => (query.state.data === null ? NULL_STALE_MS : DAY_MS),
  };
}
