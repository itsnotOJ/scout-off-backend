/**
 * Saved-search alerts (#1509).
 */
import fetch from 'node-fetch';
import {
  insertOrUpdatePlayer,
  updatePlayerProgress,
  insertSavedSearch,
  queryPlayers,
  upsertFeatureFlag,
  createWebhookSubscription,
  getDriver,
} from '../../src/db';
import { clearFeatureFlagCache, FeatureFlags } from '../../src/services/featureFlags';
import { broadcaster } from '../../src/services/eventBroadcaster';
import { getSavedSearchMatchesTotal } from '../../src/middleware/metrics';
import {
  matchesSavedSearch,
  evaluateSavedSearchAlerts,
  enqueueSavedSearchEvaluation,
  flushSavedSearchAlerts,
  SavedSearchCriteria,
} from '../../src/services/savedSearchAlerts';

const fetchMock = fetch as unknown as jest.Mock;
const SCOUT = 'GSCOUTSAVEDSEARCHALERTSAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

let seq = 0;
async function addPlayer(p: { position: string; region: string; tier?: number }): Promise<string> {
  const id = `ssa-player-${++seq}`;
  await insertOrUpdatePlayer({ player_id: id, wallet: `GW${seq}`, position: p.position, region: p.region, created_at: Date.now() });
  if (p.tier) await updatePlayerProgress(id, p.tier as never);
  return id;
}

async function setFlag(enabled: boolean): Promise<void> {
  await upsertFeatureFlag({ name: FeatureFlags.SAVED_SEARCH_ALERTS_ENABLED, enabled: enabled ? 1 : 0, updated_at: Date.now(), updated_by: 'test' } as never);
  clearFeatureFlagCache();
}

async function notificationRows(playerId: string): Promise<number> {
  const row = await getDriver().get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM saved_search_notifications WHERE scout_wallet = ? AND player_id = ?', [SCOUT, playerId]);
  return Number(row?.n ?? 0);
}

describe('matchesSavedSearch', () => {
  const player = { region: 'EU', position: 'midfielder', progress_level: 2, is_active: 1 };

  it('applies region, alias-normalised position and min tier', () => {
    expect(matchesSavedSearch(player, {})).toBe(true);
    expect(matchesSavedSearch(player, { region: 'EU', position: 'CM', minTier: 2 })).toBe(true);
    expect(matchesSavedSearch(player, { region: 'NA' })).toBe(false);
    expect(matchesSavedSearch(player, { position: 'forward' })).toBe(false);
    expect(matchesSavedSearch(player, { minTier: 3 })).toBe(false);
  });

  it('never matches deactivated players', () => {
    expect(matchesSavedSearch({ ...player, is_active: 0 }, {})).toBe(false);
  });

  it('gives the same results as the player list query (parity)', async () => {
    await addPlayer({ position: 'midfielder', region: 'PARITY', tier: 2 });
    await addPlayer({ position: 'forward', region: 'PARITY', tier: 1 });
    await addPlayer({ position: 'midfielder', region: 'PARITY' });
    await addPlayer({ position: 'defender', region: 'PARITY', tier: 3 });

    const all = await queryPlayers({ region: 'PARITY', limit: 100 });
    const cases: SavedSearchCriteria[] = [
      { region: 'PARITY' },
      { region: 'PARITY', position: 'midfielder' },
      { region: 'PARITY', minTier: 2 },
      { region: 'PARITY', position: 'forward', minTier: 1 },
      { region: 'PARITY', position: 'defender', minTier: 0 },
    ];
    for (const c of cases) {
      const fromQuery = (await queryPlayers({ ...c, limit: 100 })).map((p) => p.player_id).sort();
      const fromMatcher = all.filter((p) => matchesSavedSearch(p, c)).map((p) => p.player_id).sort();
      expect(fromMatcher).toEqual(fromQuery);
    }
  });
});

describe('evaluateSavedSearchAlerts', () => {
  let broadcastSpy: jest.SpyInstance;

  beforeAll(async () => {
    await insertSavedSearch({
      scout_wallet: SCOUT, name: 'EU mids', filters: JSON.stringify({ region: 'ALERTS', position: 'midfielder' }), created_at: Date.now(),
    });
    createWebhookSubscription('https://hooks.example.com/scout', 'scout-secret', SCOUT, ['saved_search.match' as never]);
  });

  beforeEach(async () => {
    fetchMock.mockClear();
    broadcastSpy = jest.spyOn(broadcaster, 'broadcast').mockImplementation(() => undefined);
    await setFlag(true);
  });

  afterEach(() => broadcastSpy.mockRestore());

  const scoutDeliveries = () =>
    fetchMock.mock.calls.filter(([url]) => url === 'https://hooks.example.com/scout');

  it('produces exactly one notification row, one webhook delivery and one SSE event for a new match', async () => {
    const before = getSavedSearchMatchesTotal();
    const playerId = await addPlayer({ position: 'midfielder', region: 'ALERTS' });

    await evaluateSavedSearchAlerts([playerId]);

    expect(await notificationRows(playerId)).toBe(1);
    expect(scoutDeliveries()).toHaveLength(1);
    expect(JSON.parse(scoutDeliveries()[0][1].body)).toMatchObject({
      eventType: 'saved_search.match',
      payload: { scout: SCOUT, player_id: playerId },
    });
    expect(broadcastSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'saved_search.match' }));
    expect(getSavedSearchMatchesTotal()).toBe(before + 1);
  });

  it('does not notify twice when the same player is re-processed', async () => {
    const playerId = await addPlayer({ position: 'midfielder', region: 'ALERTS' });

    await evaluateSavedSearchAlerts([playerId]);
    await evaluateSavedSearchAlerts([playerId]);
    await evaluateSavedSearchAlerts([playerId, playerId]);

    expect(await notificationRows(playerId)).toBe(1);
    expect(scoutDeliveries()).toHaveLength(1);
  });

  it('ignores players that do not match', async () => {
    const playerId = await addPlayer({ position: 'goalkeeper', region: 'ALERTS' });
    await evaluateSavedSearchAlerts([playerId]);
    expect(await notificationRows(playerId)).toBe(0);
    expect(scoutDeliveries()).toHaveLength(0);
  });

  it('evaluates and delivers nothing when the feature flag is disabled', async () => {
    await setFlag(false);
    const playerId = await addPlayer({ position: 'midfielder', region: 'ALERTS' });
    await evaluateSavedSearchAlerts([playerId]);
    expect(await notificationRows(playerId)).toBe(0);
    expect(scoutDeliveries()).toHaveLength(0);
    expect(broadcastSpy).not.toHaveBeenCalled();
  });

  it('re-notifies only after the player leaves the result set and comes back', async () => {
    const playerId = await addPlayer({ position: 'midfielder', region: 'ALERTS' });
    await evaluateSavedSearchAlerts([playerId]);

    await getDriver().run('UPDATE players SET region = ? WHERE player_id = ?', ['ELSEWHERE', playerId]);
    await evaluateSavedSearchAlerts([playerId]);
    expect(await notificationRows(playerId)).toBe(0);

    await getDriver().run('UPDATE players SET region = ? WHERE player_id = ?', ['ALERTS', playerId]);
    await evaluateSavedSearchAlerts([playerId]);
    expect(await notificationRows(playerId)).toBe(1);
    expect(scoutDeliveries()).toHaveLength(2);
  });

  it('collapses queued events for the same player into one evaluation', async () => {
    const playerId = await addPlayer({ position: 'midfielder', region: 'ALERTS' });
    enqueueSavedSearchEvaluation(playerId);
    enqueueSavedSearchEvaluation(playerId);
    enqueueSavedSearchEvaluation(playerId);
    await flushSavedSearchAlerts();

    expect(scoutDeliveries()).toHaveLength(1);
  });
});
