"use client";

import { useState } from "react";
import type { Pick } from "@/lib/stats/types";

export function PickCard({ pick }: { pick: Pick }) {
  const [open, setOpen] = useState(false);
  const probability = Math.round(pick.modelProb * 100);
  const edge = pick.edge === null ? null : Math.round(pick.edge * 100);
  const tone = pick.confidence === "high"
    ? "border-emerald-200 bg-emerald-50 text-emerald-700"
    : pick.confidence === "medium"
      ? "border-amber-200 bg-amber-50 text-amber-700"
      : "border-slate-200 bg-slate-50 text-slate-600";

  return (
    <article className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.16em] text-slate-400">{pick.market}</p>
          <h3 className="mt-1 text-base font-semibold text-slate-950">{pick.match}</h3>
          <p className="mt-1 text-sm text-slate-700">{pick.selection}</p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <span className={`rounded-full border px-2 py-1 text-xs capitalize ${tone}`}>{pick.confidence}</span>
          {pick.lowValue && <span className="rounded-full border border-rose-200 bg-rose-50 px-2 py-1 text-[10px] text-rose-700">Low value</span>}
        </div>
      </div>
      <div className="mb-2 flex items-end justify-between">
        <span className="text-2xl font-bold text-slate-950">{probability}%</span>
        <span className="text-sm text-slate-500">Model probability</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-slate-100">
        <div className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-cyan-500" style={{ width: `${probability}%` }} />
      </div>
      <div className="mt-4 grid grid-cols-3 gap-2 text-sm">
        <div className="rounded-lg bg-slate-50 p-2"><span className="block text-xs text-slate-500">Odds</span><strong className="text-slate-800">{pick.bookOdds === null ? "Model only" : pick.bookOdds.toFixed(2)}</strong></div>
        <div className="rounded-lg bg-slate-50 p-2"><span className="block text-xs text-slate-500">Edge</span><strong className={edge !== null && edge >= 0 ? "text-emerald-700" : "text-red-700"}>{edge === null ? "N/A" : `${edge >= 0 ? "+" : ""}${edge}%`}</strong></div>
        <div className="rounded-lg bg-slate-50 p-2"><span className="block text-xs text-slate-500">EV</span><strong className="text-slate-800">{pick.ev === null ? "N/A" : `${(pick.ev * 100).toFixed(1)}%`}</strong></div>
      </div>
      <button type="button" onClick={() => setOpen((value) => !value)} className="mt-3 text-sm font-medium text-cyan-800 hover:text-cyan-950">
        {open ? "Hide justification" : "View justification"}
      </button>
      {open && <p className="mt-2 border-t border-slate-100 pt-3 text-sm leading-6 text-slate-600">{pick.justification}</p>}
    </article>
  );
}
