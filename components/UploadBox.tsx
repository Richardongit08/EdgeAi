"use client";

import { useRef } from "react";

export function UploadBox({ onFile, busy }: { onFile: (file: File) => void; busy: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) onFile(file);
          event.target.value = "";
        }}
      />
      <button
        type="button"
        disabled={busy}
        onClick={() => input.current?.click()}
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-white/10 text-slate-300 hover:bg-white/5 disabled:opacity-50"
        aria-label="Upload fixtures and odds screenshot"
      >
        +
      </button>
    </>
  );
}
