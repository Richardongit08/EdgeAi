export type ScoreMatrix = number[][];

export function poissonProbability(lambda: number, k: number): number {
  if (!Number.isFinite(lambda) || lambda <= 0) return k === 0 ? 1 : 0;
  let logResult = -lambda + k * Math.log(lambda);
  for (let i = 2; i <= k; i += 1) logResult -= Math.log(i);
  return Math.exp(logResult);
}

export function buildScoreMatrix(
  lambdaHome: number,
  lambdaAway: number,
  rho = -0.1,
): ScoreMatrix {
  const matrix = Array.from({ length: 11 }, () => Array<number>(11).fill(0));
  for (let home = 0; home <= 10; home += 1) {
    for (let away = 0; away <= 10; away += 1) {
      let probability = poissonProbability(lambdaHome, home) * poissonProbability(lambdaAway, away);
      if (home === 0 && away === 0) probability *= 1 - lambdaHome * lambdaAway * rho;
      else if (home === 0 && away === 1) probability *= 1 + lambdaHome * rho;
      else if (home === 1 && away === 0) probability *= 1 + lambdaAway * rho;
      else if (home === 1 && away === 1) probability *= 1 - rho;
      matrix[home][away] = probability;
    }
  }
  return normalizeMatrix(matrix);
}

export function normalizeMatrix(matrix: ScoreMatrix): ScoreMatrix {
  const total = matrix.flat().reduce((sum, value) => sum + value, 0);
  return total > 0
    ? matrix.map((row) => row.map((value) => value / total))
    : matrix;
}

export function estimateExpectedGoals(
  homeAttack: number,
  homeDefence: number,
  awayAttack: number,
  awayDefence: number,
  leagueAvgGoals: number,
  homeAdvantage = 1.12,
): { lambdaHome: number; lambdaAway: number } {
  return {
    lambdaHome: Math.max(0.05, leagueAvgGoals * homeAttack * homeDefence * homeAdvantage),
    lambdaAway: Math.max(0.05, leagueAvgGoals * awayAttack * awayDefence),
  };
}
