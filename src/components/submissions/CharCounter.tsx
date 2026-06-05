import { cn } from "@/lib/utils";
import { CONTENT_MAX } from "@/lib/submissions/submission-input";

interface CharCounterProps {
  count: number;
  max?: number;
}

// Live `n/800` feedback for the content field. Turns red once the limit is exceeded;
// the form blocks submit past `max` (mirrors the DB CHECK char_length(btrim(content)) 1..800).
// `max` defaults to the CONTENT_MAX SSOT in submission-input.ts so the UI cap can never
// silently drift from the validator / DB constraint.
export function CharCounter({ count, max = CONTENT_MAX }: CharCounterProps) {
  const over = count > max;
  return (
    <span
      className={cn("text-xs tabular-nums transition-colors", over ? "font-medium text-red-400" : "text-slate-600")}
      aria-live="polite"
    >
      {count}/{max}
    </span>
  );
}
