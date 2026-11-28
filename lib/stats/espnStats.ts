import { teamNameSimilarity } from "@/lib/stats/fuzzy";
import type { TeamStats } from "@/lib/stats/types";

export const ESPN_LEAGUE_CODES: Record<string, string> = {
  soccer_epl: "eng.1",
  soccer_germany_bundesliga: "ger.1",
  soccer_germany_bundesliga_2: "ger.2",
  soccer_italy_serie_a: "ita.1",
  soccer_italy_serie_b: "ita.2",
  soccer_spain_la_liga: "esp.1",
  soccer_spain_segunda_division: "esp.2",
  soccer_france_ligue_one: "fra.1",
  soccer_efl_champ: "eng.2",
  soccer_netherlands_eredivisie: "ned.1",
  soccer_portugal_primeira_liga: "por.1",
  soccer_sco_premiership: "sco.1",
  soccer_belgium_first_div: "bel.1",
  soccer_turkey_super_league: "tur.1",
  soccer_uefa_champs_league: "uefa.champions",
  soccer_uefa_europa_league: "uefa.europa",
  soccer_uefa_europa_conference_league: "uefa.europa.conf",
};

interface CacheEntry {
  expiresAt: number;
  value: unknown;
}

interface EspnTeamEntry {
  team?: { id?: string; displayName?: string; name?: string; abbreviation?: string };
  stats?: Array<{ name?: string; displayName?: string; value?: string | number; displayValue?: string }>;
}

export interface EspnLeagueData {
  standings: unknown;
  scoreboard: unknown;
}

const cache = new Map<string, CacheEntry>();
const TTL_MS = 6 * 60 * 60 * 1000;

async function fetchEspnJson(url: string): Promise<unknown> {
  const cached = cache.get(url);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  if (cached) cache.delete(url);

  const response = await fetch(url, {
    cache: "no-store",
    signal: AbortSignal.timeout(4000),
  });
  if (!response.ok) throw new Error(`ESPN stats request failed (${response.status}).`);
  const value = (await response.json()) as unknown;
  cache.set(url, { expiresAt: Date.now() + TTL_MS, value });
  return value;
}

function recentScoreboardDates(): string[] {
  return Array.from({ length: 14 }, (_, index) => {
    const date = new Date();
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCDate(date.getUTCDate() - index);
    return date.toISOString().slice(0, 10).replace(/-/g, "");
  });
}

export async function getEspnLeagueData(espnCode: string): Promise<EspnLeagueData> {
  const standingsUrl = `https://site.api.espn.com/apis/v2/sports/soccer/${encodeURIComponent(espnCode)}/standings`;
  const scoreboardUrls = recentScoreboardDates().map((date) => {
    const url = new URL(
      `https://site.api.espn.com/apis/site/v2/sports/soccer/${encodeURIComponent(espnCode)}/scoreboard`,
    );
    url.searchParams.set("dates", date);
    url.searchParams.set("limit", "100");
    return url.toString();
  });
  const [standingsResult, ...scoreboardResults] = await Promise.allSettled([
    fetchEspnJson(standingsUrl),
    ...scoreboardUrls.map((url) => fetchEspnJson(url)),
  ]);
  const events = scoreboardResults.flatMap((result) => {
    if (result.status !== "fulfilled" || !isRecord(result.value) || !Array.isArray(result.value.events)) {
      return [];
    }
    return result.value.events;
  });
  const uniqueEvents = [...new Map(events.flatMap((event) => {
    if (!isRecord(event) || typeof event.id !== "string") return [];
    return [[event.id, event] as const];
  })).values()];
  const completedEvents = uniqueEvents.filter((event) => {
    if (!isRecord(event) || !isRecord(event.status) || !isRecord(event.status.type)) return false;
    return event.status.type.completed === true || event.status.type.state === "post";
  }).sort((a, b) => Date.parse(String(isRecord(b) ? b.date : "")) - Date.parse(String(isRecord(a) ? a.date : ""))).slice(0, 4);
  const boxscoreResults = await Promise.allSettled(completedEvents.map(async (event) => {
    if (!isRecord(event) || typeof event.id !== "string") return undefined;
    const url = new URL(
      `https://site.api.espn.com/apis/site/v2/sports/soccer/${encodeURIComponent(espnCode)}/summary`,
    );
    url.searchParams.set("event", event.id);
    return [event.id, await fetchEspnJson(url.toString())] as const;
  }));
  const boxscoreByEvent = new Map(boxscoreResults.flatMap((result) =>
    result.status === "fulfilled" && result.value ? [result.value] : [],
  ));
  const eventsWithBoxscores = uniqueEvents.map((event) => {
    if (!isRecord(event) || typeof event.id !== "string") return event;
    const summary = boxscoreByEvent.get(event.id);
    const boxscore = isRecord(summary) && isRecord(summary.boxscore) ? summary.boxscore : undefined;
    const teams = boxscore && Array.isArray(boxscore.teams) ? boxscore.teams.filter(isRecord) : [];
    if (!Array.isArray(event.competitions)) return event;
    const competitions = event.competitions.map((rawCompetition) => {
      if (!isRecord(rawCompetition) || !Array.isArray(rawCompetition.competitors)) return rawCompetition;
      const competitors = rawCompetition.competitors.map((rawCompetitor) => {
        if (!isRecord(rawCompetitor) || !isRecord(rawCompetitor.team)) return rawCompetitor;
        const teamId = String(rawCompetitor.team.id ?? "");
        const teamName = String(rawCompetitor.team.displayName ?? rawCompetitor.team.name ?? "");
        const boxscoreTeam = teams.find((rawTeam) => {
          const boxTeam = isRecord(rawTeam.team) ? rawTeam.team : rawTeam;
          return String(boxTeam.id ?? "") === teamId ||
            (teamName && String(boxTeam.displayName ?? boxTeam.name ?? "") === teamName);
        });
        const statistics = boxscoreTeam && Array.isArray(boxscoreTeam.statistics)
          ? boxscoreTeam.statistics
          : undefined;
        return statistics ? { ...rawCompetitor, statistics } : rawCompetitor;
      });
      return { ...rawCompetition, competitors };
    });
    return { ...event, competitions };
  });
  return {
    standings: standingsResult.status === "fulfilled" ? standingsResult.value : null,
    scoreboard: { events: eventsWithBoxscores },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function collectEntries(value: unknown, output: EspnTeamEntry[]): void {
  if (!isRecord(value)) return;
  if (Array.isArray(value.entries)) {
    for (const entry of value.entries) {
      if (isRecord(entry)) output.push(entry as EspnTeamEntry);
    }
  }
  if (Array.isArray(value.children)) {
    for (const child of value.children) collectEntries(child, output);
  }
  if (isRecord(value.standings)) collectEntries(value.standings, output);
}

function getStat(entry: EspnTeamEntry, ...names: string[]): number | undefined {
  const stat = entry.stats?.find((item) =>
    names.includes((item.name ?? "").toLowerCase()) ||
    names.includes((item.displayName ?? "").toLowerCase()),
  );
  const value = Number(stat?.value ?? stat?.displayValue);
  return Number.isFinite(value) ? value : undefined;
}

function getStatString(entry: EspnTeamEntry, ...names: string[]): string | undefined {
  const stat = entry.stats?.find((item) =>
    names.includes((item.name ?? "").toLowerCase()) ||
    names.includes((item.displayName ?? "").toLowerCase()),
  );
  return stat?.displayValue ?? (typeof stat?.value === "string" ? stat.value : undefined);
}

function toForm(form: string | undefined): number[] {
  if (!form) return [];
  return form
    .toUpperCase()
    .split("")
    .filter((result) => result === "W" || result === "D" || result === "L")
    .slice(-10)
    .map((result) => result === "W" ? 1 : result === "D" ? 0.5 : 0);
}

function getScoreboardForm(scoreboard: unknown, teamName: string): number[] {
  if (!isRecord(scoreboard) || !Array.isArray(scoreboard.events)) return [];
  const results: Array<{ date: number; form: number }> = [];
  for (const rawEvent of scoreboard.events) {
    if (!isRecord(rawEvent)) continue;
    const event = rawEvent;
    const status = isRecord(event.status) ? event.status : undefined;
    const statusType = status && isRecord(status.type) ? status.type : undefined;
    if (statusType?.completed !== true && statusType?.state !== "post") continue;
    const competitions = Array.isArray(event.competitions) ? event.competitions : [];
    const competition = competitions.find(isRecord);
    if (!competition || !Array.isArray(competition.competitors)) continue;
    const competitors = competition.competitors.filter(isRecord);
    if (competitors.length < 2) continue;
    const matched = competitors.find((competitor) => {
      if (!isRecord(competitor.team)) return false;
      const name = competitor.team.displayName ?? competitor.team.name;
      return typeof name === "string" && teamNameSimilarity(teamName, name) >= 0.62;
    });
    if (!matched) continue;
    const home = competitors.find((competitor) => competitor.homeAway === "home");
    const away = competitors.find((competitor) => competitor.homeAway === "away");
    const homeScore = Number(home?.score);
    const awayScore = Number(away?.score);
    if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore)) continue;
    const matchedIsHome = matched.homeAway === "home";
    const teamScore = matchedIsHome ? homeScore : awayScore;
    const opponentScore = matchedIsHome ? awayScore : homeScore;
    const form = teamScore > opponentScore ? 1 : teamScore === opponentScore ? 0.5 : 0;
    const date = Date.parse(String(event.date ?? ""));
    results.push({ date: Number.isFinite(date) ? date : 0, form });
  }
  return results
    .sort((a, b) => b.date - a.date)
    .slice(0, 10)
    .map((result) => result.form);
}

function getScoreboardShotAverages(
  scoreboard: unknown,
  teamName: string,
): { shotsFor: number; shotsAgainst: number } | undefined {
  if (!isRecord(scoreboard) || !Array.isArray(scoreboard.events)) return undefined;
  const values: Array<{ shotsFor: number; shotsAgainst: number }> = [];
  for (const rawEvent of scoreboard.events) {
    if (!isRecord(rawEvent) || !Array.isArray(rawEvent.competitions)) continue;
    const competition = rawEvent.competitions.find(isRecord);
    if (!competition || !Array.isArray(competition.competitors)) continue;
    const competitors = competition.competitors.filter(isRecord);
    const matched = competitors.find((competitor) => {
      if (!isRecord(competitor.team)) return false;
      const name = competitor.team.displayName ?? competitor.team.name;
      return typeof name === "string" && teamNameSimilarity(teamName, name) >= 0.62;
    });
    const opponent = competitors.find((competitor) => competitor !== matched);
    if (!matched || !opponent) continue;
    const getShots = (competitor: Record<string, unknown>) => {
      const statistics = Array.isArray(competitor.statistics)
        ? competitor.statistics.filter(isRecord)
        : [];
      const stat = statistics.find((item) => {
        const name = String(item.name ?? item.displayName ?? "").toLowerCase().replace(/[^a-z]/g, "");
        return name === "shots" || name === "totalshots";
      });
      const value = Number(stat?.value ?? stat?.displayValue);
      return Number.isFinite(value) ? value : undefined;
    };
    const shotsFor = getShots(matched);
    const shotsAgainst = getShots(opponent);
    if (shotsFor !== undefined && shotsAgainst !== undefined) values.push({ shotsFor, shotsAgainst });
  }
  if (values.length === 0) return undefined;
  return {
    shotsFor: values.reduce((total, item) => total + item.shotsFor, 0) / values.length,
    shotsAgainst: values.reduce((total, item) => total + item.shotsAgainst, 0) / values.length,
  };
}

export function getEspnTeamStats(
  standings: unknown,
  teamName: string,
  scoreboard?: unknown,
): TeamStats | undefined {
  const entries: EspnTeamEntry[] = [];
  collectEntries(standings, entries);
  const namedEntries = entries.flatMap((entry) => {
    const name = entry.team?.displayName ?? entry.team?.name;
    return name ? [{ name, entry }] : [];
  });
  const matched = namedEntries
    .map((item) => ({ ...item, similarity: teamNameSimilarity(teamName, item.name) }))
    .filter((item) => item.similarity >= 0.62)
    .sort((a, b) => b.similarity - a.similarity)[0];
  if (!matched) return undefined;

  const entry = matched.entry;
  const gamesPlayed = getStat(entry, "gamesplayed", "played") ?? 0;
  const wins = getStat(entry, "wins", "win") ?? 0;
  const draws = getStat(entry, "ties", "draws", "draw") ?? 0;
  const losses = getStat(entry, "losses", "loss") ?? 0;
  const goalsFor = getStat(entry, "pointsfor", "goalsfor", "gf") ?? 0;
  const goalsAgainst = getStat(entry, "pointsagainst", "goalsagainst", "ga") ?? 0;
  const shotsFor = getStat(entry, "shotsfor", "totalshots");
  const shotsAgainst = getStat(entry, "shotsagainst", "opponentshots");
  if (gamesPlayed <= 0) return undefined;
  const position = getStat(entry, "rank", "position", "playoffseed");
  const form = getScoreboardForm(scoreboard, matched.name);
  const boxscoreShots = getScoreboardShotAverages(scoreboard, matched.name);
  const standingsForm = toForm(getStatString(entry, "form", "streak"));
  const halfSeasonGames = Math.max(gamesPlayed / 2, 1);
  const goalsForPerSide = goalsFor / 2;
  const goalsAgainstPerSide = goalsAgainst / 2;
  return {
    form: form.length > 0 ? form : standingsForm,
    sampleSize: halfSeasonGames,
    gamesPlayed,
    wins,
    draws,
    losses,
    goalsFor,
    goalsAgainst,
    goalsForHome: goalsForPerSide,
    goalsAgainstHome: goalsAgainstPerSide,
    goalsForAway: goalsForPerSide,
    goalsAgainstAway: goalsAgainstPerSide,
    shotsFor: boxscoreShots?.shotsFor ?? (shotsFor === undefined ? undefined : shotsFor / gamesPlayed),
    shotsAgainst: boxscoreShots?.shotsAgainst ?? (shotsAgainst === undefined ? undefined : shotsAgainst / gamesPlayed),
    standingsPosition: position,
    injuries: [],
  };
}

export function leagueAverageTeamStats(leagueAvgGoals = 2.65): TeamStats {
  const baselineSample = 5;
  const baselineGoals = baselineSample * leagueAvgGoals / 2;
  return {
    form: [],
    sampleSize: baselineSample,
    isLeagueAverageBaseline: true,
    goalsForHome: baselineGoals,
    goalsAgainstHome: baselineGoals,
    goalsForAway: baselineGoals,
    goalsAgainstAway: baselineGoals,
    injuries: [],
  };
}

export function getLeagueAverageGoals(standings: unknown): number {
  const entries: EspnTeamEntry[] = [];
  collectEntries(standings, entries);
  const totals = entries.reduce(
    (result, entry) => ({
      games: result.games + (getStat(entry, "gamesplayed", "played") ?? 0),
      goals: result.goals + (getStat(entry, "pointsfor", "goalsfor", "gf") ?? 0),
    }),
    { games: 0, goals: 0 },
  );
  return totals.games > 0 && totals.goals > 0
    ? totals.goals / (totals.games / 2)
    : 2.65;
}
