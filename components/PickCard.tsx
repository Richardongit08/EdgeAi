"use client";

import { useState } from "react";
import type { Pick } from "@/lib/stats/types";

export function PickCard({ pick }: { pick: Pick }) {
  const [open, setOpen] = useState(false);
  const probability = Math.round(pick.modelProb * 100);
  const edge = pick.edge === null ? null : Math.round(pick.edge * 100);
  const tone = pick.confidence === "high"
    ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-300"
    : pick.confidence === "medium"
      ? "border-amber-400/30 bg-amber-400/10 text-amber-300"
      : "border-slate-400/30 bg-slate-400/10 text-slate-300";

  return (
    <article className="rounded-2xl border border-white/[0.08] bg-[#151820] p-4 shadow-xl shadow-black/10">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-slate-500">{pick.market}</p>
          <h3 className="mt-1 text-base font-semibold text-white">{pick.match}</h3>
          <p className="mt-1 text-sm text-slate-300">{pick.selection}</p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <span className={`rounded-full border px-2 py-1 text-xs capitalize ${tone}`}>{pick.confidence}</span>
          {pick.lowValue && <span className="rounded-full border border-rose-400/30 bg-rose-400/10 px-2 py-1 text-[10px] text-rose-300">Low value</span>}
        </div>
      </div>
      <div className="mb-2 flex items-end justify-between">
        <span className="text-2xl font-bold text-white">{probability}%</span>
        <span className="text-sm text-slate-400">Model probability</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-white/5">
        <div className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-cyan-400" style={{ width: `${probability}%` }} />
      </div>
      <div className="mt-4 grid grid-cols-3 gap-2 text-sm">
        <div className="rounded-lg bg-black/20 p-2"><span className="block text-xs text-slate-500">Odds</span><strong className="text-slate-100">{pick.bookOdds === null ? "Model only" : pick.bookOdds.toFixed(2)}</strong></div>
        <div className="rounded-lg bg-black/20 p-2"><span className="block text-xs text-slate-500">Edge</span><strong className={edge !== null && edge >= 0 ? "text-emerald-300" : "text-red-300"}>{edge === null ? "N/A" : `${edge >= 0 ? "+" : ""}${edge}%`}</strong></div>
        <div className="rounded-lg bg-black/20 p-2"><span className="block text-xs text-slate-500">EV</span><strong className="text-slate-100">{pick.ev === null ? "N/A" : `${(pick.ev * 100).toFixed(1)}%`}</strong></div>
      </div>
      <button type="button" onClick={() => setOpen((value) => !value)} className="mt-3 text-sm font-medium text-cyan-300">
        {open ? "Hide justification" : "View justification"}
      </button>
      {open && <p className="mt-2 border-t border-white/[0.07] pt-3 text-sm leading-6 text-slate-300">{pick.justification}</p>}
    </article>
  );
}
