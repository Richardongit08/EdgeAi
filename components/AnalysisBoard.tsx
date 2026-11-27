"use client";

import { useMemo, useState } from "react";
import { FilterBar } from "@/components/FilterBar";
import { PickCard } from "@/components/PickCard";
import type { Pick } from "@/lib/stats/types";

export function AnalysisBoard({ picks, onClose }: { picks: Pick[]; onClose: () => void }) {
  const [sort, setSort] = useState<"ev" | "probability" | "confidence">("probability");
  const [market, setMarket] = useState("all");
  const markets = useMemo(() => [...new Set(picks.map((pick) => pick.market))], [picks]);
  const visiblePicks = useMemo(() => {
    const confidenceRank = { high: 3, medium: 2, low: 1 };
    const filtered = market === "all" ? picks : picks.filter((pick) => pick.market === market);
    return [...filtered].sort((a, b) => {
      if (sort === "probability") return b.modelProb - a.modelProb;
      if (sort === "confidence") return confidenceRank[b.confidence] - confidenceRank[a.confidence];
      return (b.ev ?? -Infinity) - (a.ev ?? -Infinity);
    });
  }, [picks, market, sort]);

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/70 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="analysis-board-title"
        className="flex h-full w-full max-w-3xl flex-col border-l border-white/[0.08] bg-[#0b0f14] shadow-2xl shadow-black/40"
      >
        <header className="flex items-center justify-between border-b border-white/[0.07] px-5 py-4 sm:px-7">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-emerald-400/80">EdgeAI</p>
            <h2 id="analysis-board-title" className="mt-1 text-lg font-semibold text-white">Analysis Board</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="grid h-9 w-9 place-items-center rounded-full border border-white/10 text-lg text-slate-300 transition hover:bg-white/[0.06]"
            aria-label="Close analysis board"
          >
            ×
          </button>
        </header>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.06] px-5 py-3 sm:px-7">
          <div>
            <p className="text-sm font-medium text-slate-200">Ranked picks</p>
            <p className="mt-0.5 text-xs text-slate-500">Probability, value, and data quality from the statistical model</p>
          </div>
          <FilterBar sort={sort} market={market} markets={markets} onSort={setSort} onMarket={setMarket} />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
          {visiblePicks.length > 0 ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {visiblePicks.map((pick, index) => <PickCard key={`${pick.match}-${pick.selection}-${index}`} pick={pick} />)}
            </div>
          ) : (
            <div className="grid h-full min-h-64 place-items-center rounded-2xl border border-dashed border-white/[0.09] px-5 text-center">
              <div>
                <p className="text-sm font-medium text-slate-300">No picks to show yet</p>
                <p className="mt-1 text-xs text-slate-500">Ask EdgeAI to analyse a fixture or a slate first.</p>
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
