"use client";

import { FormEvent, KeyboardEvent as ReactKeyboardEvent, useEffect, useRef, useState } from "react";
import { AnalysisBoard } from "@/components/AnalysisBoard";
import { CompactPickList } from "@/components/CompactPickList";
import { UploadBox } from "@/components/UploadBox";
import { ConfirmExtraction } from "@/components/ConfirmExtraction";
import type { FixtureReference } from "@/lib/ai/intent";
import type { ExtractedBet, Pick } from "@/lib/stats/types";

interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  picks?: Pick[];
}

interface ChatResponse {
  intent?: string;
  reply?: string;
  picks?: Pick[];
  boardPicks?: Pick[];
  fixture?: FixtureReference;
  fixtureRefs?: FixtureReference[];
  openBoard?: boolean;
  error?: string;
}

const starterPrompts = [
  "3 high-probability games tonight",
  "Best goal picks today",
  "Analyse a match",
];

export default function Home() {
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [picks, setPicks] = useState<Pick[]>([]);
  const [extracted, setExtracted] = useState<ExtractedBet[]>([]);
  const [lastMatchedFixture, setLastMatchedFixture] = useState<FixtureReference | undefined>();
  const [lastFixtures, setLastFixtures] = useState<FixtureReference[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [isBoardOpen, setIsBoardOpen] = useState(false);
  const streamRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    streamRef.current?.scrollTo({ top: streamRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy, extracted]);

  useEffect(() => {
    if (!isBoardOpen) return;
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setIsBoardOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [isBoardOpen]);

  async function sendMessage(question: string) {
    if (!question.trim() || busy) return;
    const submitted = question.trim();
    setMessage("");
    if (inputRef.current) {
      inputRef.current.style.height = "auto";
      inputRef.current.style.overflowY = "hidden";
    }
    setMessages((current) => [...current, { role: "user", text: submitted }]);
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: submitted,
          context: {
            lastMatchedFixture,
            lastFixtures,
            lastPicks: picks.slice(0, 12).map(({ match, market: pickMarket, selection }) => ({
              match,
              market: pickMarket,
              selection,
            })),
          },
        }),
      });
      const text = await response.text();
      const data = JSON.parse(text) as ChatResponse;
      if (!response.ok) throw new Error(data.error ?? "Chat request failed.");
      if (data.openBoard) {
        if (data.boardPicks?.length) setPicks(data.boardPicks);
      } else if (data.intent === "best_plays" || data.intent === "analyse_match") {
        setPicks(data.boardPicks ?? data.picks ?? []);
      }
      if (data.fixture) {
        setLastMatchedFixture(data.fixture);
        setLastFixtures([data.fixture]);
      } else if (data.fixtureRefs) {
        setLastMatchedFixture(undefined);
        setLastFixtures(data.fixtureRefs);
      }
      if (data.openBoard) setIsBoardOpen(true);
      setMessages((current) => [
        ...current,
        { role: "assistant", text: data.reply ?? "", picks: data.picks ?? [] },
      ]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Chat request failed.");
    } finally {
      setBusy(false);
    }
  }

  function submitMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void sendMessage(message);
  }

  function handleInputKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage(message);
    }
  }

  function updateMessage(value: string) {
    setMessage(value);
    if (inputRef.current) {
      inputRef.current.style.height = "auto";
      inputRef.current.style.height = `${Math.min(inputRef.current.scrollHeight, 144)}px`;
      inputRef.current.style.overflowY = inputRef.current.scrollHeight > 144 ? "auto" : "hidden";
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
      const data = JSON.parse(text) as ChatResponse;
      if (!response.ok) throw new Error(data.error ?? "Analysis failed.");
      const nextPicks = data.picks ?? [];
      setPicks(data.boardPicks?.length ? data.boardPicks : nextPicks);
      if (data.fixtureRefs) {
        setLastFixtures(data.fixtureRefs);
        setLastMatchedFixture(data.fixtureRefs.length === 1 ? data.fixtureRefs[0] : undefined);
      }
      setExtracted([]);
      setMessages((current) => [
        ...current,
        {
          role: "assistant",
          text: nextPicks.length
            ? `I analysed the confirmed fixtures and ranked ${nextPicks.length} picks.`
            : data.reply ?? "No confirmed bets could be analysed.",
          picks: nextPicks,
        },
      ]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Analysis failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex h-[100dvh] min-h-[480px] flex-col bg-[#0B0F14] text-slate-100">
      <header className="mx-auto flex w-full max-w-3xl shrink-0 items-center justify-between px-4 py-4 sm:px-7">
        <div className="flex items-center gap-3">
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-emerald-500 text-xs font-black tracking-tight text-[#07120d] shadow-lg shadow-emerald-950/40">
            EA
          </div>
          <div>
            <h1 className="text-sm font-semibold tracking-wide text-white">EdgeAI</h1>
            <div className="mt-0.5 flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px_#10b981]" />
              <span className="text-[11px] text-slate-500">Live data</span>
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setIsBoardOpen(true)}
          className="flex items-center gap-2 rounded-full border border-white/[0.09] bg-[#121821] px-3.5 py-2 text-xs font-medium text-slate-300 transition hover:border-emerald-400/30 hover:text-white"
        >
          Board
          {picks.length > 0 && (
            <span className="grid min-w-5 place-items-center rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-emerald-300">
              {picks.length}
            </span>
          )}
        </button>
      </header>

      <section ref={streamRef} className="min-h-0 flex-1 overflow-y-auto px-4 sm:px-7">
        <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col">
          {messages.length === 0 ? (
            <div className="my-auto flex flex-col items-center justify-center py-10 text-center">
              <div className="mb-6 grid h-14 w-14 place-items-center rounded-2xl border border-emerald-400/15 bg-emerald-400/[0.06] text-lg font-bold text-emerald-300">
                EA
              </div>
              <p className="text-xs font-medium uppercase tracking-[0.2em] text-emerald-400/70">Your stats-led co-pilot</p>
              <h2 className="mt-3 max-w-lg text-2xl font-semibold leading-tight tracking-tight text-white sm:text-3xl">
                Football analysis, grounded in real numbers.
              </h2>
              <p className="mt-3 max-w-md text-sm leading-6 text-slate-400">
                Compare match probabilities, goals, shots, and value from live fixture data.
              </p>
              <div className="mt-7 flex max-w-xl flex-wrap justify-center gap-2">
                {starterPrompts.map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    disabled={busy}
                    onClick={() => void sendMessage(prompt)}
                    className="rounded-full border border-white/[0.09] bg-[#121821] px-4 py-2.5 text-xs text-slate-300 transition hover:border-emerald-400/30 hover:bg-[#17211f] hover:text-emerald-200 disabled:opacity-50"
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-5 py-5 sm:py-8">
              {messages.map((item, index) => (
                <article key={`${item.role}-${index}`} className={item.role === "user" ? "flex justify-end" : "flex justify-start"}>
                  {item.role === "user" ? (
                    <div className="max-w-[88%] rounded-2xl rounded-br-md bg-[#17211f] px-4 py-3 text-sm leading-6 text-slate-100 ring-1 ring-emerald-400/10">
                      {item.text}
                    </div>
                  ) : (
                    <div className="w-full max-w-[94%] py-1 text-sm leading-6 text-slate-300">
                      <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.13em] text-emerald-300/80">
                        <span className="grid h-5 w-5 place-items-center rounded-md bg-emerald-400/10 text-[9px] font-black text-emerald-300">EA</span>
                        EdgeAI
                      </div>
                      <p>{item.text}</p>
                      {item.picks && item.picks.length > 0 && (
                        <CompactPickList picks={item.picks} onOpenBoard={() => setIsBoardOpen(true)} />
                      )}
                    </div>
                  )}
                </article>
              ))}
              {busy && (
                <div className="flex items-center gap-2 py-2 text-xs text-slate-500" aria-live="polite">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
                  Checking live stats and probabilities…
                </div>
              )}
              <p className="pt-4 text-center text-[10px] text-slate-600">
                Estimates only. No outcome is guaranteed. Gamble responsibly. 18+
              </p>
            </div>
          )}
        </div>
      </section>

      <footer className="shrink-0 border-t border-white/[0.06] bg-[#0B0F14]/95 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur-xl sm:px-7 sm:pt-4">
        <div className="mx-auto w-full max-w-3xl">
          {error && (
            <div className="mb-3 rounded-xl border border-rose-400/20 bg-rose-400/[0.06] px-4 py-2.5 text-xs text-rose-200">
              {error}
            </div>
          )}
          {extracted.length > 0 && (
            <div className="mb-3 max-h-[35vh] overflow-y-auto rounded-2xl border border-emerald-400/15 bg-[#121821] p-3">
              <ConfirmExtraction
                bets={extracted}
                onChange={setExtracted}
                onConfirm={analyse}
                onCancel={() => setExtracted([])}
                busy={busy}
              />
            </div>
          )}
          <form
            onSubmit={submitMessage}
            className="flex items-end gap-2 rounded-2xl border border-white/[0.09] bg-[#121821] p-2 shadow-2xl shadow-black/20 focus-within:border-emerald-400/25"
          >
            <UploadBox onFile={upload} busy={busy} />
            <textarea
              ref={inputRef}
              rows={1}
              value={message}
              onChange={(event) => updateMessage(event.target.value)}
              onKeyDown={handleInputKeyDown}
              placeholder="Ask about games, goals, shots, or a team…"
              aria-label="Message EdgeAI"
              className="max-h-36 min-h-10 min-w-0 flex-1 resize-none overflow-hidden bg-transparent px-2 py-2.5 text-sm leading-5 text-slate-100 outline-none placeholder:text-slate-600"
            />
            <button
              type="submit"
              disabled={busy || !message.trim()}
              className="h-10 shrink-0 rounded-xl bg-[#10B981] px-4 text-xs font-semibold text-[#06130e] transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Send
            </button>
          </form>
          <p className="mt-2 text-center text-[10px] text-slate-600">
            Enter to send · Shift + Enter for a new line · Estimates only, no outcome is guaranteed · 18+
          </p>
        </div>
      </footer>

      {isBoardOpen && <AnalysisBoard picks={picks} onClose={() => setIsBoardOpen(false)} />}
    </main>
  );
}
