export interface ValueResult {
  fairProb: number;
  edge: number;
  ev: number;
  impliedProb: number;
}

export function removeMargin(odds: number[], oddsIndex: number): number[] {
  const valid = odds.filter((value) => Number.isFinite(value) && value > 0);
  if (valid.length === 0 || oddsIndex >= odds.length) return odds.map(() => 0);
  const implied = odds.map((value) => 1 / value);
  const sum = implied.reduce((total, value) => total + value, 0);
  return implied.map((value) => value / sum);
}

export function calculateValue(modelProb: number, odds: number, marketOdds: number[]): ValueResult {
  if (!Number.isFinite(odds) || odds <= 0) {
    return { fairProb: 0, edge: modelProb, ev: modelProb - 1, impliedProb: 0 };
  }
  const impliedProb = 1 / odds;
  const fair = removeMargin(marketOdds, marketOdds.indexOf(odds));
  const fairProb = fair[marketOdds.indexOf(odds)] ?? impliedProb;
  return {
    fairProb,
    edge: modelProb - fairProb,
    ev: modelProb * odds - 1,
    impliedProb,
  };
}
