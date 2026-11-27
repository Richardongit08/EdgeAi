"use client";

import { FormEvent, useMemo, useState } from "react";
import { FilterBar } from "@/components/FilterBar";
import { PickCard } from "@/components/PickCard";
import { UploadBox } from "@/components/UploadBox";
import { ConfirmExtraction } from "@/components/ConfirmExtraction";
import type { ExtractedBet, Pick } from "@/lib/stats/types";

export default function Home() {
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<Array<{ role: "user" | "assistant"; text: string }>>([]);
  const [picks, setPicks] = useState<Pick[]>([]);
  const [extracted, setExtracted] = useState<ExtractedBet[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sort, setSort] = useState<"ev" | "probability" | "confidence">("ev");
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

  async function submitMessage(event: FormEvent) {
    event.preventDefault();
    if (!message.trim() || busy) return;
    const question = message.trim();
    setMessage("");
    setMessages((current) => [...current, { role: "user", text: question }]);
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: question }),
      });
      const text = await response.text();
      const data = JSON.parse(text) as { reply?: string; picks?: Pick[]; error?: string };
      if (!response.ok) throw new Error(data.error ?? "Chat request failed.");
      if (data.picks?.length) setPicks(data.picks);
      setMessages((current) => [...current, { role: "assistant", text: data.reply ?? "" }]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Chat request failed.");
    } finally {
      setBusy(false);
    }
  }

  async function upload(file: File) {
    setBusy(true);
    setError("");
    try {
      const form = new FormData();
      form.append("image", file);
      const response = await fetch("/api/extract", { method: "POST", body: form });
      const text = await response.text();
      const data = JSON.parse(text) as { bets?: ExtractedBet[]; error?: string };
      if (!response.ok) throw new Error(data.error ?? "Extraction failed.");
      setExtracted(data.bets ?? []);
      if (!data.bets?.length) setError("No football bets could be extracted.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Extraction failed.");
    } finally {
      setBusy(false);
    }
  }

  async function analyse() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/analyse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bets: extracted }),
      });
      const text = await response.text();
      const data = JSON.parse(text) as { picks?: Pick[]; message?: string; error?: string };
      if (!response.ok) throw new Error(data.error ?? "Analysis failed.");
      setPicks(data.picks ?? []);
      setExtracted([]);
      setMessages((current) => [...current, {
        role: "assistant",
        text: data.picks?.length ? `Ranked ${data.picks.length} value pick${data.picks.length === 1 ? "" : "s"}.` : data.message ?? "No qualifying picks found.",
      }]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Analysis failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto min-h-screen w-full max-w-6xl px-4 pb-6 pt-5 md:px-6">
      <header className="mb-5 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-cyan-400 text-sm font-black text-[#091016]">EA</div>
          <div><h1 className="text-lg font-semibold text-white">EdgeAI</h1><p className="text-xs text-slate-500">Stats-led football analysis</p></div>
        </div>
        <span className="rounded-full border border-emerald-400/20 bg-emerald-400/10 px-3 py-1 text-xs text-emerald-300">Live API ready</span>
      </header>

      {error && <div className="mb-4 rounded-xl border border-red-400/20 bg-red-400/10 px-4 py-3 text-sm text-red-200">{error}</div>}

      <section className="grid gap-5 lg:grid-cols-[minmax(300px,0.78fr)_minmax(480px,1.22fr)]">
        <div className="flex min-h-[720px] flex-col overflow-hidden rounded-2xl border border-white/[0.08] bg-[#10131a]">
          <div className="flex-1 space-y-4 overflow-y-auto p-4">
            {messages.length === 0 && (
              <div className="mt-12 text-center">
                <p className="text-sm text-slate-500">Ask EdgeAI</p>
                <h2 className="mt-2 text-xl font-semibold text-white">What are the strongest value plays today?</h2>
              </div>
            )}
            {messages.map((item, index) => (
              <div key={`${item.role}-${index}`} className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-6 ${item.role === "user" ? "ml-auto bg-cyan-400 text-[#091016]" : "bg-white/[0.06] text-slate-200"}`}>{item.text}</div>
            ))}
          </div>
          {extracted.length > 0 && (
            <div className="border-t border-white/[0.07] p-3">
              <ConfirmExtraction bets={extracted} onChange={setExtracted} onConfirm={analyse} onCancel={() => setExtracted([])} busy={busy} />
            </div>
          )}
          <form onSubmit={submitMessage} className="flex gap-2 border-t border-white/[0.07] p-3">
            <UploadBox onFile={upload} busy={busy} />
            <input value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Ask about fixtures, markets or a pick..." className="min-w-0 flex-1 rounded-full border border-white/10 bg-[#171a21] px-4 text-sm text-white outline-none placeholder:text-slate-600 focus:border-cyan-400/40" />
            <button type="submit" disabled={busy} className="h-10 rounded-full bg-cyan-400 px-4 text-sm font-bold text-[#091016] disabled:opacity-50">Send</button>
          </form>
        </div>

        <div className="rounded-2xl border border-white/[0.08] bg-[#0f1218] p-4">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div><p className="text-xs uppercase tracking-[0.18em] text-slate-500">Analysis board</p><h2 className="mt-1 text-lg font-semibold text-white">Ranked picks</h2></div>
            <FilterBar sort={sort} market={market} markets={markets} onSort={setSort} onMarket={setMarket} />
          </div>
          {visiblePicks.length === 0 ? (
            <div className="grid min-h-[620px] place-items-center rounded-xl border border-dashed border-white/[0.08] text-center">
              <div><p className="text-sm font-medium text-slate-400">No picks to rank</p><p className="mt-1 max-w-xs text-xs text-slate-600">Upload a fixtures and odds screenshot, confirm the extracted bets, then analyse.</p></div>
            </div>
          ) : (
            <div className="grid gap-3 md:grid-cols-2">{visiblePicks.map((pick, index) => <PickCard key={`${pick.match}-${pick.selection}-${index}`} pick={pick} />)}</div>
          )}
        </div>
      </section>
      <footer className="py-5 text-center text-xs text-slate-600">Estimates only. No outcome is guaranteed. Gamble responsibly. 18+</footer>
    </main>
  );
}
