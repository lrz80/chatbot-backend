// src/lib/voice/realtime/toolGuards/resolveSubmitBookingStepValue.ts
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

  /**
   * The caller may already have selected which source should be tried first.
   * Example:
   * - handleRealtimeSubmitBookingStep loops through candidates
   * - candidate.source is passed as resolved_candidate_source
   *
   * This resolver must preserve that ordering instead of always preferring model.
   */
  preferredSource?: "model" | "transcript";
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

function uniqueCandidates(
  candidates: SubmitStepCandidate[]
): SubmitStepCandidate[] {
  const seen = new Set<string>();

  return candidates.filter((candidate) => {
    const source = clean(candidate.source) as SubmitStepCandidate["source"];
    const value = clean(candidate.value);
    const key = `${source}:${value}`;

    if (!value) return false;
    if (seen.has(key)) return false;

    seen.add(key);
    return true;
  });
}

function buildOrderedCandidates(params: {
  modelValue: string;
  transcriptValue: string;
  preferredSource?: "model" | "transcript";
}): SubmitStepCandidate[] {
  const { modelValue, transcriptValue, preferredSource } = params;

  if (preferredSource === "transcript") {
    return uniqueCandidates([
      {
        source: "transcript",
        value: transcriptValue,
      },
      {
        source: "model",
        value: modelValue,
      },
    ]);
  }

  if (preferredSource === "model") {
    return uniqueCandidates([
      {
        source: "model",
        value: modelValue,
      },
      {
        source: "transcript",
        value: transcriptValue,
      },
    ]);
  }

  /**
   * Safe default:
   * transcript first.
   *
   * Do not default to model first because submit_booking_step is used for
   * sensitive booking values such as name, datetime, phone and confirmation.
   */
  return uniqueCandidates([
    {
      source: "transcript",
      value: transcriptValue,
    },
    {
      source: "model",
      value: modelValue,
    },
  ]);
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

  const candidates = buildOrderedCandidates({
    modelValue,
    transcriptValue,
    preferredSource: params.preferredSource,
  });

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