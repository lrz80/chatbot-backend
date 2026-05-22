//src/lib/voice/realtime/toolGuards/resolveSubmitBookingStepValue.ts
import type { CallState } from "../../types";

export type SubmitStepCandidate = {
  source: "model" | "transcript";
  value: string;
};

export type ResolveSubmitBookingStepValueParams = {
  stepKey: string;
  modelValue: unknown;
  transcriptValue: unknown;
  realtimeState: CallState;
};

export type ResolveSubmitBookingStepValueResult =
  | {
      ok: true;
      value: string;
      source: "model" | "transcript";
      candidates: SubmitStepCandidate[];
    }
  | {
      ok: false;
      error: "EMPTY_SUBMIT_BOOKING_STEP_VALUE";
      candidates: SubmitStepCandidate[];
    };

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function uniqueCandidates(candidates: SubmitStepCandidate[]): SubmitStepCandidate[] {
  const seen = new Set<string>();

  return candidates.filter((candidate) => {
    const key = `${candidate.source}:${candidate.value}`;
    if (!candidate.value) return false;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Esta función NO valida si el valor es correcto para el negocio.
 * Solo decide qué candidatos se deben intentar resolver.
 *
 * La validación real debe ocurrir en el handler del step:
 * - service => contra servicios/catálogo/provider
 * - staff => contra staff/provider config
 * - datetime => parser/availability
 * - phone => phone parser
 * - email => email parser
 * - confirmation => confirmation resolver
 */
export function resolveSubmitBookingStepValue(
  params: ResolveSubmitBookingStepValueParams
): ResolveSubmitBookingStepValueResult {
  const modelValue = clean(params.modelValue);
  const transcriptValue = clean(params.transcriptValue);

  const candidates = uniqueCandidates([
    {
      source: "model",
      value: modelValue,
    },
    {
      source: "transcript",
      value: transcriptValue,
    },
  ]);

  const firstCandidate = candidates[0];

  if (!firstCandidate) {
    return {
      ok: false,
      error: "EMPTY_SUBMIT_BOOKING_STEP_VALUE",
      candidates,
    };
  }

  return {
    ok: true,
    value: firstCandidate.value,
    source: firstCandidate.source,
    candidates,
  };
}