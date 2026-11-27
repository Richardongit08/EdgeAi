export function eloProbability(homeRating: number, awayRating: number): number {
  return 1 / (1 + Math.pow(10, (awayRating - homeRating) / 400));
}
