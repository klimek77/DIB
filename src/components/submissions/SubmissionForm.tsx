import React, { useState } from "react";
import { ArrowLeft, ArrowRight, Lightbulb, MessageCircle, Send, TriangleAlert, Wrench } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { ServerError } from "@/components/auth/ServerError";
import { CharCounter } from "@/components/submissions/CharCounter";
import { CONTENT_MAX, CONTENT_MIN, SIGNATURE_MAX } from "@/lib/submissions/submission-input";
import { BRANCHES, DEPARTMENTS, TOPICS, type Topic } from "@/lib/submissions/taxonomies";
import { cn } from "@/lib/utils";

// Public 3-step submission wizard (FR-003). Logic is owned by this plan/contract; the dark /
// emerald form-world aesthetic follows design §4.1 (the same recipes Phase 3 applied to the
// welcome + success pages). Option values are read VERBATIM from taxonomies.ts — a single
// diacritic drift would pass client validation only to fail the DB CHECK on INSERT.
//
// Steps: (1) oddział [BRANCHES, required] → (2) tematyka [TOPICS] → (3) treść [≤800, counter]
// + dział [DEPARTMENTS, optional] + podpis [optional]. Final submit POSTs the whitelisted shape
// { branch, topic, content, department?, signature? } as JSON to /api/submissions, then navigates
// to /submit-success. The route returns in <1s by never awaiting AI; we only await the fetch.

// Icon + accent colour per topic (design §1.1 "Kolory kategorii wpisów"). Keyed by the exact
// taxonomy value so it stays in lockstep with TOPICS.
const TOPIC_META: Record<Topic, { icon: LucideIcon; color: string; description: string }> = {
  Pomysł: { icon: Lightbulb, color: "#059669", description: "Nowa koncepcja, którą warto rozważyć." },
  Problem: { icon: TriangleAlert, color: "#dc2626", description: "Coś nie działa lub utrudnia pracę." },
  Usprawnienie: { icon: Wrench, color: "#2563eb", description: "Drobna zmiana, która ułatwi codzienność." },
  Inne: { icon: MessageCircle, color: "#6b7280", description: "Coś, co nie pasuje do pozostałych kategorii." },
};

const inputBase =
  "w-full rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3.5 text-base text-slate-200 outline-none transition-colors focus:border-emerald-600/50 placeholder:text-slate-600";

function primaryButtonClass(enabled: boolean): string {
  return cn(
    "inline-flex items-center gap-2 rounded-xl px-8 py-3 text-[0.95rem] font-semibold transition-all",
    enabled
      ? "bg-gradient-to-br from-emerald-600 to-emerald-500 text-white shadow-[0_4px_24px_rgba(5,150,105,0.3)] hover:from-emerald-500 hover:to-emerald-400"
      : "cursor-not-allowed bg-white/[0.05] text-slate-600",
  );
}

const secondaryButtonClass =
  "inline-flex items-center gap-2 rounded-xl border border-white/10 bg-transparent px-6 py-3 text-[0.95rem] font-medium text-slate-400 transition-all hover:bg-white/[0.06]";

export default function SubmissionForm() {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [branch, setBranch] = useState("");
  const [topic, setTopic] = useState("");
  const [content, setContent] = useState("");
  const [department, setDepartment] = useState("");
  const [signature, setSignature] = useState("");
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const branchValid = (BRANCHES as readonly string[]).includes(branch);
  const topicValid = (TOPICS as readonly string[]).includes(topic);
  const contentLength = content.trim().length;
  const contentValid = contentLength >= CONTENT_MIN && contentLength <= CONTENT_MAX;

  function goTo(next: 1 | 2 | 3) {
    setServerError(null);
    setStep(next);
  }

  async function submit() {
    if (!branchValid || !topicValid || !contentValid || submitting) return;

    setSubmitting(true);
    setServerError(null);

    // Build exactly the whitelisted shape the endpoint accepts. Empty optional fields are
    // omitted (the validator treats undefined / "" as "not provided").
    const payload: {
      branch: string;
      topic: string;
      content: string;
      department?: string;
      signature?: string;
    } = { branch, topic, content: content.trim() };
    if (department) payload.department = department;
    const trimmedSignature = signature.trim();
    if (trimmedSignature) payload.signature = trimmedSignature;

    try {
      const response = await fetch("/api/submissions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        window.location.href = "/submit-success";
        return;
      }

      const data = (await response.json().catch(() => null)) as { error?: string } | null;
      setServerError(data?.error ?? "Nie udało się wysłać zgłoszenia. Spróbuj ponownie.");
    } catch {
      setServerError("Wystąpił problem z połączeniem. Spróbuj ponownie.");
    } finally {
      setSubmitting(false);
    }
  }

  function handleSubmit(e: React.SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    if (step === 1) {
      if (branchValid) goTo(2);
      return;
    }
    if (step === 2) {
      if (topicValid) goTo(3);
      return;
    }
    void submit();
  }

  return (
    <form onSubmit={handleSubmit} noValidate>
      {/* StepProgress — 3 segments (design §4.1) */}
      <div className="mb-8 flex gap-1.5">
        {[1, 2, 3].map((n) => (
          <div
            key={n}
            className={cn(
              "h-[3px] flex-1 rounded-sm transition-all duration-300",
              n <= step ? "bg-gradient-to-r from-emerald-600 to-emerald-400" : "bg-white/[0.08]",
            )}
          />
        ))}
      </div>

      <div key={step} className="animate-in fade-in slide-in-from-bottom-4 duration-300">
        {step === 1 && (
          <fieldset>
            <legend className="mb-1 text-xl font-medium text-slate-100">Z jakiego oddziału piszesz?</legend>
            <p className="mb-6 text-sm text-slate-400">Wybierz oddział, którego dotyczy Twoja sugestia.</p>
            <div className="grid grid-cols-2 gap-2.5">
              {BRANCHES.map((b) => {
                const selected = branch === b;
                return (
                  <button
                    key={b}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => {
                      setBranch(b);
                      setServerError(null);
                    }}
                    className={cn(
                      "rounded-xl border px-4 py-3.5 text-left text-[0.95rem] transition-all",
                      selected
                        ? "border-emerald-600/50 bg-emerald-600/15 font-medium text-emerald-400"
                        : "border-white/[0.08] bg-white/[0.04] text-slate-400 hover:bg-white/[0.08]",
                    )}
                  >
                    {b}
                  </button>
                );
              })}
            </div>
          </fieldset>
        )}

        {step === 2 && (
          <fieldset>
            <legend className="mb-1 text-xl font-medium text-slate-100">Jaki to typ wpisu?</legend>
            <p className="mb-6 text-sm text-slate-400">Wybierz kategorię, która najlepiej opisuje Twoją sugestię.</p>
            <div className="flex flex-col gap-2.5">
              {TOPICS.map((t) => {
                const meta = TOPIC_META[t];
                const Icon = meta.icon;
                const selected = topic === t;
                return (
                  <button
                    key={t}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => {
                      setTopic(t);
                      setServerError(null);
                    }}
                    style={selected ? { color: meta.color } : undefined}
                    className={cn(
                      "flex items-center gap-3.5 rounded-[14px] border px-5 py-[18px] text-left transition-all",
                      selected
                        ? "border-current/40 bg-current/10 font-medium"
                        : "border-white/[0.08] bg-white/[0.03] text-slate-300 hover:bg-white/[0.06]",
                    )}
                  >
                    <Icon className="size-5 shrink-0" style={{ color: meta.color }} aria-hidden="true" />
                    <span>
                      <span className="block text-[0.95rem]">{t}</span>
                      <span className="mt-0.5 block text-xs text-slate-500">{meta.description}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </fieldset>
        )}

        {step === 3 && (
          <div>
            <h2 className="mb-1 text-xl font-medium text-slate-100">Opisz swoją sugestię</h2>
            <p className="mb-6 text-sm text-slate-400">
              Napisz, czego dotyczy Twoja sugestia. Dział i podpis są opcjonalne.
            </p>

            <div className="space-y-5">
              <div>
                <div className="mb-1.5 flex items-baseline justify-between">
                  <label htmlFor="content" className="text-sm text-slate-400">
                    Treść sugestii
                  </label>
                  <CharCounter count={content.length} />
                </div>
                <textarea
                  id="content"
                  value={content}
                  onChange={(e) => {
                    setContent(e.target.value);
                    setServerError(null);
                  }}
                  placeholder="Opisz swój pomysł, problem lub usprawnienie…"
                  rows={6}
                  className={cn(inputBase, "min-h-[160px] resize-y leading-relaxed")}
                />
              </div>

              <div>
                <label htmlFor="department" className="mb-1.5 block text-sm text-slate-400">
                  Dział <span className="text-slate-600">(opcjonalnie)</span>
                </label>
                <select
                  id="department"
                  value={department}
                  onChange={(e) => {
                    setDepartment(e.target.value);
                    setServerError(null);
                  }}
                  className={cn(inputBase, "cursor-pointer appearance-none")}
                >
                  <option value="" className="text-slate-800">
                    — wybierz dział —
                  </option>
                  {DEPARTMENTS.map((d) => (
                    <option key={d} value={d} className="text-slate-800">
                      {d}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="signature" className="mb-1.5 block text-sm text-slate-400">
                  Podpis <span className="text-slate-600">(opcjonalnie)</span>
                </label>
                <input
                  id="signature"
                  type="text"
                  value={signature}
                  maxLength={SIGNATURE_MAX}
                  onChange={(e) => {
                    setSignature(e.target.value);
                    setServerError(null);
                  }}
                  placeholder="Imię, inicjały lub pseudonim — jeśli chcesz"
                  className={inputBase}
                />
              </div>
            </div>
          </div>
        )}
      </div>

      <ServerError message={serverError} />

      {/* Navigation (design §4.1: Wstecz / Dalej | Wyślij) */}
      <div className={cn("mt-8 flex items-center", step === 1 ? "justify-end" : "justify-between")}>
        {step > 1 && (
          <button
            type="button"
            className={secondaryButtonClass}
            onClick={() => {
              goTo((step - 1) as 1 | 2);
            }}
          >
            <ArrowLeft className="size-4" aria-hidden="true" />
            Wstecz
          </button>
        )}

        {step < 3 ? (
          <button
            type="submit"
            disabled={step === 1 ? !branchValid : !topicValid}
            className={primaryButtonClass(step === 1 ? branchValid : topicValid)}
          >
            Dalej
            <ArrowRight className="size-4" aria-hidden="true" />
          </button>
        ) : (
          <button
            type="submit"
            disabled={!contentValid || submitting}
            className={primaryButtonClass(contentValid && !submitting)}
          >
            {submitting ? (
              <>
                <span className="size-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                Wysyłanie…
              </>
            ) : (
              <>
                <Send className="size-4" aria-hidden="true" />
                Wyślij anonimowo
              </>
            )}
          </button>
        )}
      </div>
    </form>
  );
}
