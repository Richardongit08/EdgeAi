interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

const cache = new Map<string, CacheEntry<unknown>>();
const TTL_MS = 6 * 60 * 60 * 1000;
const dailyCalls = new Map<string, number>();
const MAX_DAILY_CALLS = 100;

function getCached<T>(key: string): T | undefined {
  const entry = cache.get(key) as CacheEntry<T> | undefined;
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}

async function apiFootballGet<T>(path: string, params: Record<string, string | number>): Promise<T> {
  const key = `${path}:${JSON.stringify(params)}`;
  const cached = getCached<T>(key);
  if (cached !== undefined) return cached;

  const apiKey = process.env.FOOTBALL_API_KEY || process.env.API_FOOTBALL_KEY;
  if (!apiKey) throw new Error("FOOTBALL_API_KEY is not configured.");
  const day = new Date().toISOString().slice(0, 10);
  const calls = dailyCalls.get(day) ?? 0;
  if (calls >= MAX_DAILY_CALLS) throw new Error("API-Football daily 100-call quota reached.");
  dailyCalls.set(day, calls + 1);

  const url = new URL(`https://v3.football.api-sports.io/${path}`);
  Object.entries(params).forEach(([name, value]) => url.searchParams.set(name, String(value)));
  const response = await fetch(url, {
    headers: { "x-apisports-key": apiKey },
    cache: "no-store",
    signal: AbortSignal.timeout(4000),
  });
  if (response.status === 429) throw new Error("API-Football rate limit reached. Please try again later.");
  if (!response.ok) throw new Error(`API-Football request failed (${response.status}).`);

  const value = (await response.json()) as T;
  cache.set(key, { value, expiresAt: Date.now() + TTL_MS });
  return value;
}

export async function getFixtures(params: Record<string, string | number>) {
  return apiFootballGet<{ response: Array<unknown>; errors: unknown }>("fixtures", params);
}

export async function getTeamStatistics(team: number, league: number, season: number) {
  return apiFootballGet<{ response: unknown; errors: unknown }>("teams/statistics", {
    team,
    league,
    season,
  });
}

export async function getTeamFixtures(team: number, season: number) {
  return apiFootballGet<{ response: Array<unknown>; errors: unknown }>("fixtures", {
    team,
    season,
    last: 10,
  });
}

export async function getHeadToHead(teamA: number, teamB: number) {
  return apiFootballGet<{ response: Array<unknown>; errors: unknown }>("fixtures/headtohead", {
    h2h: `${teamA}-${teamB}`,
  });
}

export async function getInjuries(team: number) {
  return apiFootballGet<{ response: Array<unknown>; errors: unknown }>("injuries", { team });
}

export async function searchTeams(name: string) {
  return apiFootballGet<{ response: Array<{ team: { id: number; name: string } }>; errors: unknown }>(
    "teams",
    { search: name },
  );
}

export async function getLeagueStandings(league: number, season: number) {
  return apiFootballGet<{ response: Array<unknown>; errors: unknown }>("standings", {
    league,
    season,
  });
}

export async function getApiFootballOdds(fixtureId: number) {
  return apiFootballGet<{ response: Array<unknown>; errors: unknown }>("odds", {
    fixture: fixtureId,
  });
}
