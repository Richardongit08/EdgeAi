"use client";

import type { Pick } from "@/lib/stats/types";

export function CompactPickList({
  picks,
  onOpenBoard,
}: {
  picks: Pick[];
  onOpenBoard: () => void;
}) {
  return (
    <div className="mt-4 space-y-2">
      {picks.map((pick, index) => (
        <div
          key={`${pick.match}-${pick.market}-${pick.selection}-${index}`}
          className="rounded-xl border border-white/[0.07] bg-[#0b0f14] px-3 py-3"
        >
          <p className="text-sm font-medium text-slate-200">{pick.match}</p>
          <div className="mt-1 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <p className="text-sm font-semibold text-emerald-300">
              {pick.selection} · {Math.round(pick.modelProb * 100)}%
            </p>
            <p className="text-xs tabular-nums text-slate-400">
              {pick.bookOdds === null ? "@ Model Fair Odds" : `@ ${pick.bookOdds.toFixed(2)}`}
            </p>
          </div>
        </div>
      ))}
      <button
        type="button"
        onClick={onOpenBoard}
        className="pt-1 text-xs font-medium text-emerald-300/80 transition hover:text-emerald-200"
      >
        Open Analysis Board ↗
      </button>
    </div>
  );
}
