function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\bnott['’]?m\b/g, "nottingham")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function teamNameSimilarity(first: string, second: string): number {
  const left = normalize(first);
  const right = normalize(second);
  if (!left || !right) return 0;
  const leftTokens = left.split(" ");
  const rightTokens = right.split(" ");
  const shorter = leftTokens.length <= rightTokens.length ? leftTokens : rightTokens;
  const longer = leftTokens.length <= rightTokens.length ? rightTokens : leftTokens;
  const similarities = shorter.map((token) =>
    Math.max(...longer.map((candidate) => {
      const distance = levenshtein(token, candidate);
      return 1 - distance / Math.max(token.length, candidate.length);
    })),
  );
  return similarities.reduce((sum, score) => sum + score, 0) / similarities.length;
}

export function levenshtein(a: string, b: string): number {
  const left = normalize(a);
  const right = normalize(b);
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const temporary = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (left[i - 1] === right[j - 1] ? 0 : 1));
      previous = temporary;
    }
  }
  return row[right.length];
}

export function fuzzyTeamMatch<T extends { name: string }>(query: string, teams: T[]): T | undefined {
  if (teams.length === 0) return undefined;
  const normalizedQuery = normalize(query);
  return teams
    .map((team) => ({
      team,
      distance: levenshtein(normalizedQuery, normalize(team.name)),
    }))
    .sort((a, b) => a.distance - b.distance)[0]?.team;
}
