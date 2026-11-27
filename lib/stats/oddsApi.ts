import { teamNameSimilarity } from "@/lib/stats/fuzzy";

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

export interface OddsFixture {
  id: string;
  sport_key: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers: Array<{
    key: string;
    title: string;
    markets: Array<{
      key: "h2h" | "totals" | "spreads" | string;
      outcomes: Array<{ name: string; price: number; point?: number }>;
    }>;
  }>;
}

const cache = new Map<string, CacheEntry<OddsFixture[]>>();
const TTL_MS = 30 * 60 * 1000;
export const ODDS_SPORT_KEYS = [
  "soccer_epl",
  "soccer_germany_bundesliga",
  "soccer_italy_serie_a",
  "soccer_spain_la_liga",
  "soccer_france_ligue_one",
  "soccer_efl_champ",
  "soccer_uefa_champs_league",
  "soccer_uefa_europa_league",
] as const;

export function getSportKeyForLeague(league?: string): string {
  const value = (league ?? "").toLowerCase();
  if (/bundesliga|germany|german/.test(value)) return "soccer_germany_bundesliga";
  if (/serie a|italy|italian/.test(value)) return "soccer_italy_serie_a";
  if (/la liga|spain|spanish/.test(value)) return "soccer_spain_la_liga";
  if (/ligue 1|france|french/.test(value)) return "soccer_france_ligue_one";
  if (/championship|england second|efl/.test(value)) return "soccer_efl_champ";
  if (/champions league|uefa champions/.test(value)) return "soccer_uefa_champs_league";
  if (/europa league|uefa europa/.test(value)) return "soccer_uefa_europa_league";
  return "soccer_epl";
}

export async function getLiveOdds(sportKey: string): Promise<OddsFixture[]> {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) return [];
  const key = `odds:${sportKey}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  if (cached) cache.delete(key);

  const url = new URL(`https://api.the-odds-api.com/v4/sports/${sportKey}/odds`);
  url.searchParams.set("apiKey", apiKey);
  url.searchParams.set("regions", "eu");
  url.searchParams.set("markets", "h2h,totals,spreads");
  url.searchParams.set("oddsFormat", "decimal");
  try {
    const response = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) return [];
    const payload = (await response.json()) as unknown;
    if (!Array.isArray(payload)) return [];
    const value = payload as OddsFixture[];
    cache.set(key, { value, expiresAt: Date.now() + TTL_MS });
    return value;
  } catch {
    return [];
  }
}

export async function getUpcomingOddsFixtures(): Promise<OddsFixture[]> {
  const results = await Promise.allSettled(ODDS_SPORT_KEYS.map((sportKey) => getLiveOdds(sportKey)));
  const now = Date.now();
  return results.flatMap((result) =>
    result.status === "fulfilled"
      ? result.value.filter((fixture) => Date.parse(fixture.commence_time) >= now)
      : [],
  ).sort((a, b) => Date.parse(a.commence_time) - Date.parse(b.commence_time));
}

export function findOddsFixture(fixtures: OddsFixture[], homeName: string, awayName: string): OddsFixture | undefined {
  return fixtures
    .map((fixture) => {
      const directHome = teamNameSimilarity(homeName, fixture.home_team);
      const directAway = teamNameSimilarity(awayName, fixture.away_team);
      const reverseHome = teamNameSimilarity(homeName, fixture.away_team);
      const reverseAway = teamNameSimilarity(awayName, fixture.home_team);
      const directScore = (directHome + directAway) / 2;
      const reverseScore = (reverseHome + reverseAway) / 2;
      return {
        fixture,
        score: Math.max(directScore, reverseScore),
        teamScores: directScore >= reverseScore
          ? [directHome, directAway]
          : [reverseHome, reverseAway],
      };
    })
    .filter((match) => match.teamScores.every((score) => score >= 0.72))
    .sort((a, b) => b.score - a.score)[0]?.fixture;
}

export function getMarketOdds(
  fixture: OddsFixture | undefined,
  selection: string,
  market: string,
): number | null {
  if (!fixture) return null;
  const wantedMarket = market.toLowerCase().includes("over") || market.toLowerCase().includes("under")
    ? "totals"
    : market.toLowerCase().includes("spread") || market.toLowerCase().includes("handicap")
      ? "spreads"
      : "h2h";
  for (const bookmaker of fixture.bookmakers) {
    const marketData = bookmaker.markets.find((item) => item.key === wantedMarket);
    if (!marketData) continue;
    const normalizedSelection = selection.toLowerCase();
    const line = Number((selection.match(/\d+(?:\.\d+)?/) ?? market.match(/\d+(?:\.\d+)?/))?.[0]);
    const outcome = marketData.outcomes.find((item) => {
      const selectionMatches =
        item.name.toLowerCase().includes(normalizedSelection) ||
        normalizedSelection.includes(item.name.toLowerCase());
      const totalMatches = wantedMarket !== "totals" || !Number.isFinite(line) || item.point === line;
      return selectionMatches && totalMatches;
    });
    if (outcome) return outcome.price;
  }
  return null;
}
