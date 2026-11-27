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
        value={sort}
        onChange={(event) => onSort(event.target.value as Props["sort"])}
        className="rounded-lg border border-white/10 bg-[#171a21] px-3 py-2 text-sm text-slate-200"
        aria-label="Sort picks"
      >
        <option value="ev">Sort: expected value</option>
        <option value="probability">Sort: probability</option>
        <option value="confidence">Sort: confidence</option>
      </select>
      <select
        value={market}
        onChange={(event) => onMarket(event.target.value)}
        className="rounded-lg border border-white/10 bg-[#171a21] px-3 py-2 text-sm text-slate-200"
        aria-label="Filter market"
      >
        <option value="all">All markets</option>
        {markets.map((item) => <option key={item} value={item}>{item}</option>)}
      </select>
    </div>
  );
}
