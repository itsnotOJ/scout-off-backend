/**
 * Saved-search alerts (#1509).
 *
 * When the indexer changes a player (registration, milestone approval / tier
 * promotion, profile update) the player id is queued here. A debounced worker
 * evaluates each queued player once against every active saved search and,
 * for each scout with a new match:
 *   1. claims the (scout_wallet, player_id) row in saved_search_notifications
 *      (INSERT … ON CONFLICT DO NOTHING — the dedup point, so a replayed
 *      ledger or concurrent worker never alerts twice);
 *   2. delivers a `saved_search.match` webhook to that scout's subscriptions
 *      (respecting each subscription's event_types) and an SSE event;
 *   3. increments scout_off_saved_search_matches_total.
 * If the player no longer matches any of a scout's searches the row is
 * cleared, so the scout is alerted again if the player re-enters the results.
 *
 * Everything is gated by the `saved_search_alerts_enabled` feature flag.
 *
 * Cost per flush: one query for active searches + one player lookup per queued
 * player; matching is O(players × searches) in memory, with region/position
 * checked first as a cheap pre-filter. Debouncing collapses many events for the
 * same player in one ledger into a single evaluation.
 */
import {
  getAllActiveSavedSearches,
  getPlayerById,
  claimSavedSearchNotification,
  deleteSavedSearchNotification,
  type SavedSearchRow,
} from '../db';
import type { PlayerRow } from '../db/repositories/players';
import { FeatureFlags, isFeatureEnabled } from './featureFlags';
import { dispatchScoutWebhook } from './webhooks';
import { broadcaster } from './eventBroadcaster';
import { incrementSavedSearchMatchesTotal } from '../middleware/metrics';
import { normalizePositionOrFallback } from '../utils/positionAliases';
import { logger } from '../utils/logger';

export const SAVED_SEARCH_MATCH_EVENT = 'saved_search.match';

/** Indexer event types that can change whether a player matches a search. */
export const SAVED_SEARCH_TRIGGER_EVENTS: ReadonlySet<string> = new Set([
  'player_registered',
  'milestone_approved',
  'profile_updated',
]);

export interface SavedSearchCriteria {
  region?: string;
  position?: string;
  minTier?: number;
}

type MatchablePlayer = Pick<PlayerRow, 'region' | 'position' | 'progress_level' | 'is_active'>;

/**
 * Pure matcher with the same semantics as the player list query
 * (GET /api/players): exact region, alias-normalised position, minimum tier,
 * active players only.
 */
export function matchesSavedSearch(player: MatchablePlayer, criteria: SavedSearchCriteria): boolean {
  if (player.is_active !== 1) return false;
  if (criteria.region && player.region !== criteria.region) return false;
  if (criteria.position && player.position !== normalizePositionOrFallback(criteria.position)) return false;
  if (criteria.minTier !== undefined && criteria.minTier !== null && player.progress_level < criteria.minTier) return false;
  return true;
}

function parseCriteria(row: SavedSearchRow): SavedSearchCriteria | null {
  try {
    return JSON.parse(row.filters) as SavedSearchCriteria;
  } catch {
    return null;
  }
}

/** Evaluate players against all active saved searches and deliver new matches. */
export async function evaluateSavedSearchAlerts(playerIds: Iterable<string>): Promise<void> {
  if (!(await isFeatureEnabled(FeatureFlags.SAVED_SEARCH_ALERTS_ENABLED))) return;

  const ids = [...new Set(playerIds)];
  if (ids.length === 0) return;

  const searches = (await getAllActiveSavedSearches())
    .map((row) => ({ row, criteria: parseCriteria(row) }))
    .filter((s): s is { row: SavedSearchRow; criteria: SavedSearchCriteria } => s.criteria !== null);
  if (searches.length === 0) return;

  for (const playerId of ids) {
    const player = await getPlayerById(playerId);
    if (!player) continue;

    // scout_wallet → ids of that scout's searches the player matches
    const byScout = new Map<string, number[]>();
    for (const { row, criteria } of searches) {
      if (!byScout.has(row.scout_wallet)) byScout.set(row.scout_wallet, []);
      if (matchesSavedSearch(player, criteria)) byScout.get(row.scout_wallet)!.push(row.id);
    }

    for (const [scout, searchIds] of byScout) {
      if (searchIds.length === 0) {
        // Left the result set: allow a future re-entry to alert again.
        await deleteSavedSearchNotification(scout, playerId);
        continue;
      }
      if (!(await claimSavedSearchNotification(scout, playerId, Date.now()))) continue;

      const payload = {
        scout,
        player_id: player.player_id,
        search_ids: searchIds,
        position: player.position,
        region: player.region,
        tier: player.progress_level,
        timestamp: new Date().toISOString(),
      };
      incrementSavedSearchMatchesTotal();
      broadcaster.broadcast({ type: SAVED_SEARCH_MATCH_EVENT, payload });
      await dispatchScoutWebhook(scout, SAVED_SEARCH_MATCH_EVENT, payload);
    }
  }
}

// ─── Debounced queue ──────────────────────────────────────────────────────────

const DEBOUNCE_MS = 500;
const pending = new Set<string>();
let timer: NodeJS.Timeout | null = null;

/** Flush the queue now (also used by tests and on shutdown). */
export async function flushSavedSearchAlerts(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  const batch = [...pending];
  pending.clear();
  try {
    await evaluateSavedSearchAlerts(batch);
  } catch (err) {
    logger.warn('[savedSearchAlerts] evaluation failed', { err: err instanceof Error ? err.message : String(err) });
  }
}

/** Queue a player for evaluation; many calls within DEBOUNCE_MS collapse into one pass. */
export function enqueueSavedSearchEvaluation(playerId: string): void {
  pending.add(playerId);
  if (!timer) {
    timer = setTimeout(() => { void flushSavedSearchAlerts(); }, DEBOUNCE_MS);
    timer.unref?.();
  }
}
