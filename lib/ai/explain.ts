import type { Pick } from "@/lib/stats/types";
import { generateWithFallback } from "@/lib/ai/generate";

export async function explainPicks(picks: Pick[], statsSummary: string): Promise<string[]> {
  if (picks.length === 0) return [];
  let content = "";
  try {
    content = await generateWithFallback(
      `Use only the numbers provided. Never add statistics from memory. If data is missing, say insufficient data. Write 2-4 sentences per pick.\n\nStats summary: ${statsSummary}\n\nPicks: ${JSON.stringify(picks)}`,
      { temperature: 0.2 },
    );
  } catch {
    return picks.map((pick) => pick.justification);
  }
  return picks.map((pick, index) => {
    const section = content.split(/\n\n+/)[index]?.trim();
    return section || `${pick.selection}: ${pick.justification}`;
  });
}
