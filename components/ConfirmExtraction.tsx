"use client";

import type { ExtractedBet } from "@/lib/stats/types";

interface Props {
  bets: ExtractedBet[];
  onChange: (bets: ExtractedBet[]) => void;
  onConfirm: () => void;
  onCancel: () => void;
  busy: boolean;
}

export function ConfirmExtraction({ bets, onChange, onConfirm, onCancel, busy }: Props) {
  const update = (index: number, field: keyof ExtractedBet, value: string) => {
    onChange(bets.map((bet, betIndex) => betIndex === index
      ? { ...bet, [field]: field === "odds" ? (value ? Number(value) : null) : value }
      : bet));
  };
  return (
    <div className="rounded-2xl border border-cyan-200 bg-cyan-50/60 p-4">
      <h3 className="mb-3 font-semibold text-slate-900">Confirm extracted bets</h3>
      <div className="space-y-2">
        {bets.map((bet, index) => (
          <div key={`${bet.home}-${bet.away}-${index}`} className="grid gap-2 md:grid-cols-[1fr_1fr_1fr_1fr_90px]">
            {(["home", "away", "market", "selection"] as const).map((field) => (
              <input key={field} value={bet[field]} onChange={(event) => update(index, field, event.target.value)} className="min-w-0 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800" placeholder={field} />
            ))}
            <input type="number" step="0.01" value={bet.odds ?? ""} onChange={(event) => update(index, "odds", event.target.value)} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800" placeholder="Odds" />
          </div>
        ))}
      </div>
      <div className="mt-4 flex gap-2">
        <button type="button" onClick={onConfirm} disabled={busy} className="rounded-lg bg-cyan-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">Analyse bets</button>
        <button type="button" onClick={onCancel} className="rounded-lg border border-slate-200 px-4 py-2 text-sm text-slate-600">Cancel</button>
      </div>
    </div>
  );
}
