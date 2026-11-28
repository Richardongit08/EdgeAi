"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { FilterBar } from "@/components/FilterBar";
import { PickCard } from "@/components/PickCard";
import { UploadBox } from "@/components/UploadBox";
import { ConfirmExtraction } from "@/components/ConfirmExtraction";
import type { ExtractedBet, Pick } from "@/lib/stats/types";

type Message = {
  id: string;
  role: "user" | "assistant";
  text: string;
  timestamp: string;
  picks?: Pick[];
};

function currentTime(): string {
  return new Intl.DateTimeFormat("en", {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date());
}

function renderInline(text: string) {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g).map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={index} className="font-semibold text-slate-950">{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return <code key={index} className="rounded bg-slate-100 px-1.5 py-0.5 text-[0.92em]">{part.slice(1, -1)}</code>;
    }
    if (part.startsWith("*") && part.endsWith("*")) {
      return <em key={index}>{part.slice(1, -1)}</em>;
    }
    return part;
  });
}

function renderReply(text: string) {
  return text.split("\n").map((line, index) => (
    line.startsWith("- ")
      ? <p key={index} className="pl-1 leading-7">{renderInline(line.slice(2))}</p>
      : line
        ? <p key={index} className="leading-7">{renderInline(line)}</p>
        : <div key={index} className="h-2" />
  ));
}

function ArrowDownIcon() {
  return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="h-5 w-5"><path d="M12 4v15m0 0 6-6m-6 6-6-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function SendIcon() {
  return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="h-5 w-5"><path d="M12 19V5m0 0L6 11m6-6 6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function HelpfulIcon({ down = false }: { down?: boolean }) {
  return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={`h-4 w-4 ${down ? "rotate-180" : ""}`}><path d="M7 10v10H4a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1h3Zm0 0 4-7a3 3 0 0 1 2 3v3h5a2 2 0 0 1 2 2l-1 7a2 2 0 0 1-2 2H7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

export default function Home() {
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [picks, setPicks] = useState<Pick[]>([]);
  const [extracted, setExtracted] = useState<ExtractedBet[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sort, setSort] = useState<"ev" | "probability" | "confidence">("probability");
  const [market, setMarket] = useState("all");
  const [isBoardOpen, setIsBoardOpen] = useState(false);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [feedback, setFeedback] = useState<Record<string, "helpful" | "not-helpful">>({});
  const [lastMatchedFixture, setLastMatchedFixture] = useState<{ home: string; away: string }>();
  const [isAtBottom, setIsAtBottom] = useState(true);
  const streamRef = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    if (isAtBottom && streamRef.current) {
      streamRef.current.scrollTo({ top: streamRef.current.scrollHeight, behavior: "smooth" });
    }
  }, [messages, isAtBottom, busy]);

  function addMessage(role: Message["role"], text: string, messagePicks?: Pick[]) {
    setMessages((current) => [...current, {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role,
      text,
      timestamp: currentTime(),
      picks: messagePicks,
    }]);
  }

  async function submitMessage(event: FormEvent) {
    event.preventDefault();
    if (!message.trim() || busy) return;
    const question = message.trim();
    setMessage("");
    addMessage("user", question);
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: question, lastMatchedFixture }),
      });
      const text = await response.text();
      const data = JSON.parse(text) as {
        reply?: string;
        picks?: Pick[];
        error?: string;
        openBoard?: boolean;
        fixture?: { home: string; away: string };
      };
      if (!response.ok) throw new Error(data.error ?? "Chat request failed.");
      if (data.picks?.length) {
        setPicks((current) => {
          const byKey = new Map(current.map((pick) => [
            `${pick.match.toLowerCase()}|${pick.market.toLowerCase()}|${pick.selection.toLowerCase()}`,
            pick,
          ]));
          data.picks?.forEach((pick) => byKey.set(
            `${pick.match.toLowerCase()}|${pick.market.toLowerCase()}|${pick.selection.toLowerCase()}`,
            pick,
          ));
          return [...byKey.values()];
        });
      }
      if (data.fixture) setLastMatchedFixture(data.fixture);
      if (data.openBoard === true) setIsBoardOpen(true);
      addMessage("assistant", data.reply ?? "", data.picks);
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
      const nextPicks = data.picks ?? [];
      setPicks(nextPicks);
      setExtracted([]);
      addMessage(
        "assistant",
        nextPicks.length
          ? `Ranked ${nextPicks.length} uploaded pick${nextPicks.length === 1 ? "" : "s"}. Open the Board to review their full stats.`
          : data.message ?? "No qualifying picks found.",
        nextPicks,
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Analysis failed.");
    } finally {
      setBusy(false);
    }
  }

  function handleStreamScroll() {
    if (!streamRef.current) return;
    const distanceToBottom = streamRef.current.scrollHeight - streamRef.current.scrollTop - streamRef.current.clientHeight;
    setShowScrollButton(distanceToBottom > 100);
    setIsAtBottom(distanceToBottom <= 100);
  }

  const datePill = new Intl.DateTimeFormat("en", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date());

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col bg-white px-4 sm:px-6">
      <header className="sticky top-0 z-10 flex h-[68px] shrink-0 items-center justify-between border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="flex items-center gap-3">
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-cyan-400 text-xs font-black text-slate-950">EA</div>
          <div className="flex items-center gap-2">
            <h1 className="text-[17px] font-semibold tracking-tight text-slate-950">EdgeAI</h1>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-medium text-emerald-700">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              Live stats
            </span>
          </div>
        </div>
        {picks.length > 0 && (
          <button
            type="button"
            onClick={() => setIsBoardOpen(true)}
            className="rounded-full border border-slate-200 px-3.5 py-1.5 text-xs font-medium text-slate-600 transition hover:border-slate-300 hover:bg-slate-50"
          >
            Board <span className="ml-1 text-slate-400">{picks.length}</span>
          </button>
        )}
      </header>

      <section
        ref={streamRef}
        onScroll={handleStreamScroll}
        className="flex-1 overflow-y-auto pb-5 pt-4"
        aria-label="Conversation"
      >
        <div className="mb-8 flex justify-center">
          <span className="rounded-full bg-slate-100 px-3 py-1 text-[11px] font-medium text-slate-500">{datePill}</span>
        </div>
        {messages.length === 0 && (
          <div className="mx-auto mt-16 max-w-lg text-center sm:mt-24">
            <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-cyan-50 text-sm font-black text-cyan-800">EA</div>
            <p className="mt-5 text-sm font-medium text-slate-500">Your football punter co-pilot</p>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950 sm:text-3xl">What would you like to analyse?</h2>
            <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-slate-500">Ask for one high-probability pick per match, a specific fixture verdict, or a full stats board.</p>
            <div className="mt-6 flex flex-wrap justify-center gap-2">
              {["Safest goals plays today", "Analyse a match", "Show the analysis board"].map((suggestion) => (
                <button key={suggestion} type="button" onClick={() => setMessage(suggestion)} className="rounded-full border border-slate-200 px-3.5 py-2 text-xs text-slate-600 transition hover:bg-slate-50">
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="space-y-7">
          {messages.map((item) => (
            <article key={item.id} className={item.role === "user" ? "flex justify-end" : "flex justify-start"}>
              {item.role === "user" ? (
                <div className="max-w-[88%] rounded-2xl bg-slate-100 px-4 py-3 text-sm leading-6 text-slate-800 sm:max-w-[80%]">
                  {item.text}
                </div>
              ) : (
                <div className="w-full max-w-[94%] text-[14px] text-slate-700 sm:max-w-[90%]">
                  <div className="space-y-2">{renderReply(item.text)}</div>
                  {item.picks && item.picks.length > 0 && (
                    <button type="button" onClick={() => setIsBoardOpen(true)} className="mt-3 text-xs font-medium text-cyan-800 hover:text-cyan-950">
                      View full stats board ↗
                    </button>
                  )}
                  <div className="mt-3 flex items-center gap-3 text-[11px] text-slate-400">
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(item.text);
                        } catch {
                          setError("Could not copy this response to the clipboard.");
                        }
                      }}
                      className="transition hover:text-slate-700"
                    >Copy</button>
                    <button
                      type="button"
                      onClick={() => setFeedback((current) => ({ ...current, [item.id]: "helpful" }))}
                      aria-label="Helpful"
                      aria-pressed={feedback[item.id] === "helpful"}
                      className={`transition hover:text-slate-700 ${feedback[item.id] === "helpful" ? "text-cyan-800" : ""}`}
                    ><HelpfulIcon /></button>
                    <button
                      type="button"
                      onClick={() => setFeedback((current) => ({ ...current, [item.id]: "not-helpful" }))}
                      aria-label="Not helpful"
                      aria-pressed={feedback[item.id] === "not-helpful"}
                      className={`transition hover:text-slate-700 ${feedback[item.id] === "not-helpful" ? "text-cyan-800" : ""}`}
                    ><HelpfulIcon down /></button>
                    <span className="ml-1">{item.timestamp}</span>
                  </div>
                </div>
              )}
            </article>
          ))}
          {busy && <p className="animate-pulse text-sm text-slate-400">Checking live fixtures and stats…</p>}
        </div>
        {extracted.length > 0 && (
          <div className="mt-5 rounded-2xl border border-slate-200 bg-white p-3">
            <ConfirmExtraction bets={extracted} onChange={setExtracted} onConfirm={analyse} onCancel={() => setExtracted([])} busy={busy} />
          </div>
        )}
      </section>

      <div className="sticky bottom-0 z-10 bg-gradient-to-t from-white via-white to-white/90 pb-3 pt-2">
        {error && <div role="alert" className="mb-2 rounded-xl border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700">{error}</div>}
        {showScrollButton && (
          <button
            type="button"
            onClick={() => streamRef.current?.scrollTo({ top: streamRef.current.scrollHeight, behavior: "smooth" })}
            aria-label="Scroll to latest message"
            className="absolute -top-12 left-1/2 grid h-9 w-9 -translate-x-1/2 place-items-center rounded-full border border-slate-200 bg-white text-slate-600 shadow-md transition hover:bg-slate-50"
          ><ArrowDownIcon /></button>
        )}
        <form onSubmit={submitMessage} className="flex min-h-[54px] items-center gap-2 rounded-full border border-slate-200 bg-white px-2 py-1.5 shadow-sm focus-within:border-slate-300">
          <UploadBox onFile={upload} busy={busy} />
          <input
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="Ask EdgeAI anything..."
            aria-label="Message EdgeAI"
            className="min-w-0 flex-1 bg-transparent px-1 text-sm text-slate-900 outline-none placeholder:text-slate-400"
          />
          <button type="submit" disabled={busy || !message.trim()} aria-label="Send message" className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-slate-950 text-white transition hover:bg-slate-800 disabled:bg-slate-200 disabled:text-slate-400">
            <SendIcon />
          </button>
        </form>
        <p className="mt-2 text-center text-[10px] text-slate-400">Estimates only. No outcome is guaranteed. Gamble responsibly. 18+</p>
      </div>

      {isBoardOpen && (
        <div className="fixed inset-0 z-30 flex justify-end bg-slate-950/25" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setIsBoardOpen(false);
        }}>
          <aside aria-label="Analysis Board" className="flex h-full w-full max-w-xl flex-col border-l border-slate-200 bg-white shadow-2xl">
            <header className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
              <div><p className="text-xs font-medium uppercase tracking-[0.16em] text-slate-400">Analysis Board</p><h2 className="mt-1 text-lg font-semibold text-slate-950">Full stats</h2></div>
              <button type="button" onClick={() => setIsBoardOpen(false)} aria-label="Close Analysis Board" className="rounded-full px-3 py-1.5 text-sm text-slate-500 hover:bg-slate-100">Close</button>
            </header>
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-3">
              <FilterBar sort={sort} market={market} markets={markets} onSort={setSort} onMarket={setMarket} />
              <span className="text-xs text-slate-400">{visiblePicks.length} picks</span>
            </div>
            <div className="flex-1 overflow-y-auto p-4 sm:p-5">
              {visiblePicks.length === 0
                ? <p className="py-16 text-center text-sm text-slate-500">No picks yet. Ask for a fixture recommendation to build the board.</p>
                : <div className="space-y-3">{visiblePicks.map((pick, index) => <PickCard key={`${pick.match}-${pick.selection}-${index}`} pick={pick} />)}</div>}
            </div>
          </aside>
        </div>
      )}
    </main>
  );
}
