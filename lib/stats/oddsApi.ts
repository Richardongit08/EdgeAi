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
  "soccer_efl_champ",
  "soccer_germany_bundesliga",
  "soccer_germany_bundesliga_2",
  "soccer_italy_serie_a",
  "soccer_italy_serie_b",
  "soccer_spain_la_liga",
  "soccer_spain_segunda_division",
  "soccer_france_ligue_one",
  "soccer_netherlands_eredivisie",
  "soccer_portugal_primeira_liga",
  "soccer_sco_premiership",
  "soccer_belgium_first_div",
  "soccer_turkey_super_league",
  "soccer_uefa_champs_league",
  "soccer_uefa_europa_league",
  "soccer_uefa_europa_conference_league",
] as const;

export function getSportKeyForLeague(league?: string): string {
  const value = (league ?? "").toLowerCase();
  if (/2\.?\s*bundesliga|bundesliga 2/.test(value)) return "soccer_germany_bundesliga_2";
  if (/serie b/.test(value)) return "soccer_italy_serie_b";
  if (/segunda/.test(value)) return "soccer_spain_segunda_division";
  if (/bundesliga|germany|german/.test(value)) return "soccer_germany_bundesliga";
  if (/eredivisie|netherlands|dutch/.test(value)) return "soccer_netherlands_eredivisie";
  if (/primeira|portugal|portuguese/.test(value)) return "soccer_portugal_primeira_liga";
  if (/scottish|scotland|premiership/.test(value)) return "soccer_sco_premiership";
  if (/belgian|belgium|pro league/.test(value)) return "soccer_belgium_first_div";
  if (/turkish|turkey|süper|super lig/.test(value)) return "soccer_turkey_super_league";
  if (/conference league/.test(value)) return "soccer_uefa_europa_conference_league";
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
  url.searchParams.set("markets", "h2h,totals,spreads,btts,draw_no_bet,double_chance");
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
  const end = now + 36 * 60 * 60 * 1000;
  return results.flatMap((result) =>
    result.status === "fulfilled"
      ? result.value.filter((fixture) => {
          const kickoff = Date.parse(fixture.commence_time);
          return kickoff >= now && kickoff <= end;
        })
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
  const normalizedMarket = market.toLowerCase();
  const isDoubleChance = normalizedMarket.includes("double chance");
  const wantedMarket = normalizedMarket.includes("over") || normalizedMarket.includes("under") ||
    normalizedMarket.includes("total")
    ? "totals"
    : normalizedMarket.includes("spread") || normalizedMarket.includes("handicap")
      ? "spreads"
      : "h2h";
  const normalizedSelection = selection.toLowerCase().replace(/[^a-z0-9]/g, "");
  const line = Number((selection.match(/[+-]?\s*\d+(?:\.\d+)?/) ?? market.match(/[+-]?\s*\d+(?:\.\d+)?/))?.[0].replace(/\s/g, ""));

  if (isDoubleChance) {
    const match = normalizedSelection.match(/1x|x2|12/);
    if (!match) return null;
    const neededNames = match[0] === "1x" ? ["home", "draw"]
      : match[0] === "x2" ? ["draw", "away"] : ["home", "away"];
    for (const bookmaker of fixture.bookmakers) {
      const outcomes = bookmaker.markets.find((item) => item.key === "h2h")?.outcomes ?? [];
      const prices = neededNames.map((name) => {
        const outcome = outcomes.find((item) => {
          const outcomeName = item.name.toLowerCase().replace(/[^a-z0-9]/g, "");
          if (name === "draw") return /^(draw|tie|x)$/.test(outcomeName);
          if (name === "home") {
            return /^(home|1)$/.test(outcomeName) ||
              teamNameSimilarity(item.name, fixture.home_team) >= 0.72;
          }
          return /^(away|2)$/.test(outcomeName) ||
            teamNameSimilarity(item.name, fixture.away_team) >= 0.72;
        });
        return outcome?.price;
      });
      const validPrices = prices.filter((price): price is number =>
        price !== undefined && Number.isFinite(price) && price > 1,
      );
      if (validPrices.length === 2) {
        const combinedOdds = 1 / validPrices.reduce((sum, price) => sum + 1 / price, 0);
        if (Number.isFinite(combinedOdds) && combinedOdds > 1) return combinedOdds;
      }
    }
    return null;
  }

  for (const bookmaker of fixture.bookmakers) {
    const marketData = bookmaker.markets.find((item) => item.key === wantedMarket);
    if (!marketData) continue;
    const outcome = marketData.outcomes.find((item) => {
      const outcomeName = item.name.toLowerCase().replace(/[^a-z0-9]/g, "");
      const selectionMatches = outcomeName === normalizedSelection ||
        normalizedSelection.startsWith(outcomeName) ||
        (/^(home|1)$/.test(normalizedSelection) &&
          (/^(home|1)$/.test(outcomeName) || teamNameSimilarity(item.name, fixture.home_team) >= 0.72)) ||
        (/^(away|2)$/.test(normalizedSelection) &&
          (/^(away|2)$/.test(outcomeName) || teamNameSimilarity(item.name, fixture.away_team) >= 0.72)) ||
        (/^(draw|tie|x)$/.test(normalizedSelection) && /^(draw|tie|x)$/.test(outcomeName)) ||
        teamNameSimilarity(selection, item.name) >= 0.72;
      const totalMatches = wantedMarket !== "totals" || !Number.isFinite(line) || item.point === line;
      const spreadMatches = wantedMarket !== "spreads" || !Number.isFinite(line) || item.point === line;
      return selectionMatches && totalMatches && spreadMatches &&
        Number.isFinite(item.price) && item.price > 1;
    });
    if (outcome) return outcome.price;
  }
  return null;
}
