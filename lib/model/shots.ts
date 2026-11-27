export interface ShotMarketProbability {
  over: number;
  under: number;
}

export interface ShotMarketProbabilities {
  expectedTotalShots: number;
  expectedShotsOnTarget: number;
  totalShots: Record<number, ShotMarketProbability>;
  shotsOnTarget: Record<number, ShotMarketProbability>;
}

function poissonCdf(lambda: number, maximum: number): number {
  if (lambda === 0) return 1;
  let probability = Math.exp(-lambda);
  let total = probability;
  for (let goals = 1; goals <= maximum; goals += 1) {
    probability *= lambda / goals;
    total += probability;
  }
  return Math.max(0, Math.min(1, total));
}

function probabilityAtLine(lambda: number, line: number): ShotMarketProbability {
  const under = poissonCdf(lambda, Math.floor(line));
  return { over: 1 - under, under };
}

export function deriveShotMarketProbabilities(
  homeTotalShots: number,
  awayTotalShots: number,
  homeShotsOnTarget: number,
  awayShotsOnTarget: number,
): ShotMarketProbabilities | undefined {
  const inputs = [homeTotalShots, awayTotalShots, homeShotsOnTarget, awayShotsOnTarget];
  if (inputs.some((value) => !Number.isFinite(value) || value < 0)) return undefined;

  const expectedTotalShots = homeTotalShots + awayTotalShots;
  const expectedShotsOnTarget = homeShotsOnTarget + awayShotsOnTarget;
  return {
    expectedTotalShots,
    expectedShotsOnTarget,
    totalShots: Object.fromEntries(
      [21.5, 23.5, 25.5].map((line) => [line, probabilityAtLine(expectedTotalShots, line)]),
    ),
    shotsOnTarget: {
      7.5: probabilityAtLine(expectedShotsOnTarget, 7.5),
    },
  };
}
