"use client";

interface Props {
  sort: "ev" | "probability" | "confidence";
  market: string;
  markets: string[];
  onSort: (sort: "ev" | "probability" | "confidence") => void;
  onMarket: (market: string) => void;
}

export function FilterBar({ sort, market, markets, onSort, onMarket }: Props) {
  return (
    <div className="flex flex-wrap gap-2">
      <select
        value={market}
        onChange={(event) => onMarket(event.target.value)}
        className="rounded-lg border border-white/[0.09] bg-[#121821] px-3 py-2 text-xs text-slate-200 outline-none focus:border-emerald-400/30"
        aria-label="Filter market"
      >
        <option value="all">All markets</option>
        {markets.map((item) => <option key={item} value={item}>{item}</option>)}
      </select>
      <select
        value={sort}
        onChange={(event) => onSort(event.target.value as Props["sort"])}
        className="rounded-lg border border-white/[0.09] bg-[#121821] px-3 py-2 text-xs text-slate-200 outline-none focus:border-emerald-400/30"
        aria-label="Sort picks"
      >
        <option value="probability">Highest probability</option>
        <option value="ev">Expected value</option>
        <option value="confidence">Confidence</option>
      </select>
    </div>
  );
}
