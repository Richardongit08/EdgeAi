import { fuzzyTeamMatch } from "@/lib/stats/fuzzy";

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
const TTL_MS = 6 * 60 * 60 * 1000;

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
  const response = await fetch(url, {
    cache: "no-store",
    signal: AbortSignal.timeout(4000),
  });
  if (!response.ok) return [];
  const value = (await response.json()) as OddsFixture[];
  cache.set(key, { value, expiresAt: Date.now() + TTL_MS });
  return value;
}

export function findOddsFixture(fixtures: OddsFixture[], homeName: string, awayName: string): OddsFixture | undefined {
  const candidates = fixtures.map((fixture) => {
    const homeOptions = [{ name: fixture.home_team }];
    const awayOptions = [{ name: fixture.away_team }];
    const homeMatch = fuzzyTeamMatch(homeName, homeOptions);
    const awayMatch = fuzzyTeamMatch(awayName, awayOptions);
    const homeDistance = homeMatch ? 0 : 1;
    const awayDistance = awayMatch ? 0 : 1;
    return { fixture, distance: homeDistance + awayDistance };
  });
  return candidates.sort((a, b) => a.distance - b.distance)[0]?.fixture;
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
    const outcome = marketData.outcomes.find((item) =>
      item.name.toLowerCase().includes(normalizedSelection) ||
      normalizedSelection.includes(item.name.toLowerCase()),
    );
    if (outcome) return outcome.price;
  }
  return null;
}
