// src/lib/voice/booking/services/square/handleSquareBookingServiceRealtimeStep.ts

import type { CallState, VoiceLocale } from "../../../types";
import type {
  BookingFlowStepLike,
  BookingState,
} from "../../../realtime/realtimeBookingFlowUtils";
import { getSquareConnectionForTenant } from "../../../../integrations/square/getSquareConnectionForTenant";
import { getSquareBookableServices } from "../../../../integrations/square/getSquareBookableServices";
import {
  getSquareServiceName,
  resolveSquareServiceChoiceFromInput,
  resolveSquareServiceFromInput,
} from "./squareServiceMatcher";
import {
  getPendingSquareServiceChoice,
  setPendingSquareServiceChoice,
} from "./squareServiceChoiceState";
import { applyResolvedSquareService } from "./applyResolvedSquareService";
import { buildBookingServiceRetryResult } from "../buildBookingServiceRetryResult";
import { getLocalizedBookingStepPrompt } from "../getLocalizedBookingStepPrompt";
import { traducirTexto } from "../../../../traducirTexto";
import { resolveSquareServiceWithCatalogContext } from "./resolveSquareServiceWithCatalogContext";
import {
  findSquareServiceAmbiguityFromCandidates,
  findSquareServiceAmbiguityFromInput,
} from "./findSquareServiceAmbiguityFromInput";

type HandleSquareBookingServiceRealtimeStepParams = {
  tenantId: string;
  currentStep: BookingFlowStepLike;
  currentIndex: number;
  currentLocale: VoiceLocale;
  value: string;
  targetSlot: string;
  stepKey: string;
  rawAnswers: Record<string, string>;
  workingState: CallState;
  steps: BookingFlowStepLike[];
  buildRealtimeBookingState: (params: {
    steps: BookingFlowStepLike[];
    state: CallState;
    explicitCurrentIndex?: number | null;
    finalConfirmationGranted?: boolean;
    readyToCreate?: boolean;
  }) => BookingState;
};

export type HandleSquareBookingServiceRealtimeStepResult =
  | {
      kind: "return";
      result: any;
    }
  | {
      kind: "continue";
      workingState: CallState;
    };

function normalizeServiceInput(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pushUniqueServiceInput(target: string[], value: unknown) {
  const raw = String(value ?? "").trim();

  if (!raw) return;

  if (!target.includes(raw)) {
    target.push(raw);
  }

  const normalized = normalizeServiceInput(raw);

  if (normalized && !target.includes(normalized)) {
    target.push(normalized);
  }
}

async function buildSquareServiceInputCandidates(params: {
  tenantId: string;
  input: string;
  currentLocale: VoiceLocale;
}): Promise<string[]> {
  const candidates: string[] = [];

  pushUniqueServiceInput(candidates, params.input);

  const shouldTranslate = String(params.input || "").trim().length >= 3;

  if (!shouldTranslate) {
    return candidates;
  }

  try {
    const translated = await traducirTexto(params.input, "en");

    pushUniqueServiceInput(candidates, translated);

    console.log("[VOICE_BOOKING][SQUARE_SERVICE_TRANSLATION_CANDIDATES]", {
      tenantId: params.tenantId,
      locale: params.currentLocale,
      input: params.input,
      translated,
      candidates,
    });
  } catch (error) {
    console.warn("[VOICE_BOOKING][SQUARE_SERVICE_TRANSLATION_FAILED]", {
      tenantId: params.tenantId,
      locale: params.currentLocale,
      input: params.input,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return candidates;
}

function getSquareServicesByExactNames(params: {
  services: any[];
  names: string[];
}): any[] {
  const wanted = new Set(
    params.names.map((name) => String(name ?? "").trim()).filter(Boolean)
  );

  if (wanted.size === 0) {
    return [];
  }

  return params.services.filter((service) =>
    wanted.has(String(getSquareServiceName(service) ?? "").trim())
  );
}

function hasExactResolvedServiceCandidate(params: {
  inputCandidates: string[];
  resolvedServiceName: string;
}): boolean {
  const resolved = normalizeServiceInput(params.resolvedServiceName);

  if (!resolved) return false;

  return params.inputCandidates.some(
    (candidate) => normalizeServiceInput(candidate) === resolved
  );
}

function buildSquareAmbiguousServicePrompt(params: {
  basePrompt: string;
  serviceOptions: string[];
}): string {
  const cleanBasePrompt = String(params.basePrompt ?? "").trim();

  const cleanOptions = params.serviceOptions
    .map((option) => String(option ?? "").trim())
    .filter(Boolean)
    .slice(0, 8);

  if (cleanOptions.length === 0) {
    return cleanBasePrompt;
  }

  const optionLines = cleanOptions
    .map((option, index) => `${index + 1}. ${option}`)
    .join("\n");

  return `${cleanBasePrompt}\n\nOpciones disponibles:\n${optionLines}`;
}

export async function handleSquareBookingServiceRealtimeStep(
  params: HandleSquareBookingServiceRealtimeStepParams
): Promise<HandleSquareBookingServiceRealtimeStepResult> {
  const {
    tenantId,
    currentStep,
    currentIndex,
    currentLocale,
    value,
    targetSlot,
    stepKey,
    rawAnswers,
    workingState,
    steps,
    buildRealtimeBookingState,
  } = params;

  const connectionResult = await getSquareConnectionForTenant(tenantId);

  if (!connectionResult.ok) {
    const prompt = getLocalizedBookingStepPrompt({
      step: currentStep,
      locale: currentLocale,
      field: "retry_prompt",
    })

    return buildBookingServiceRetryResult({
      error: "SQUARE_CONNECTION_NOT_AVAILABLE",
      prompt,
      currentStep,
      currentIndex,
      currentLocale,
      workingState,
      steps,
      serviceOptions: [],
      buildRealtimeBookingState,
    });
  }

  const pendingChoice = getPendingSquareServiceChoice(workingState);

  if (pendingChoice) {
    const selected = resolveSquareServiceChoiceFromInput({
      input: value,
      options: pendingChoice.options,
    });

    if (selected.kind === "resolved") {
      const nextState = await applyResolvedSquareService({
        tenantId,
        connection: connectionResult.connection,
        currentIndex,
        rawAnswers,
        workingState,
        targetSlot,
        stepKey,
        input: value,
        service: selected.service,
        serviceName: selected.serviceName,
        score: selected.score,
      });

      return {
        kind: "continue",
        workingState: nextState,
      };
    }

    const stateForRetry =
      selected.kind === "ambiguous"
        ? setPendingSquareServiceChoice({
            state: workingState,
            input: value,
            options: selected.options,
          })
        : workingState;

    const prompt = getLocalizedBookingStepPrompt({
      step: currentStep,
      locale: currentLocale,
      field: "retry_prompt",
    })

    return buildBookingServiceRetryResult({
      error:
        selected.kind === "ambiguous"
          ? "AMBIGUOUS_BOOKING_SERVICE"
          : "UNRESOLVED_BOOKING_SERVICE_CHOICE",
      prompt,
      currentStep,
      currentIndex,
      currentLocale,
      workingState: stateForRetry,
      steps,
      serviceOptions:
        selected.kind === "ambiguous"
          ? selected.options.map((service) => getSquareServiceName(service))
          : pendingChoice.options.map((service) => getSquareServiceName(service)),
      buildRealtimeBookingState,
    });
  }

  const servicesResult = await getSquareBookableServices({
    accessToken: connectionResult.connection.accessToken,
    environment: connectionResult.connection.environment,
  });

  if (!servicesResult.ok) {
    const prompt = getLocalizedBookingStepPrompt({
      step: currentStep,
      locale: currentLocale,
      field: "retry_prompt",
    })

    return buildBookingServiceRetryResult({
      error: servicesResult.error,
      prompt,
      currentStep,
      currentIndex,
      currentLocale,
      workingState,
      steps,
      serviceOptions: [],
      buildRealtimeBookingState,
    });
  }

  const serviceInputCandidates = await buildSquareServiceInputCandidates({
    tenantId,
    input: value,
    currentLocale,
  });

  let match: ReturnType<typeof resolveSquareServiceFromInput> | null = null;
  let matchedInput = value;

  for (const candidate of serviceInputCandidates) {
    const candidateMatch = resolveSquareServiceFromInput({
      input: candidate,
      services: servicesResult.services,
      debug: true,
    });

    if (candidateMatch.kind === "resolved") {
      match = candidateMatch;
      matchedInput = candidate;
      break;
    }

    if (!match || candidateMatch.kind === "ambiguous") {
      match = candidateMatch;
      matchedInput = candidate;
    }
  }

  if (!match || match.kind !== "resolved") {
    const contextMatch = await resolveSquareServiceWithCatalogContext({
      tenantId,
      input: value,
      currentLocale,
      services: servicesResult.services,
    });

    if (contextMatch.kind === "resolved") {
      const contextCandidateMatch = resolveSquareServiceFromInput({
        input: contextMatch.matchedName,
        services: servicesResult.services,
        debug: true,
      });

      if (contextCandidateMatch.kind === "resolved") {
        match = contextCandidateMatch;
        matchedInput = contextMatch.matchedName;
      } else {
        console.warn("[VOICE_BOOKING][SQUARE_CONTEXT_MATCH_NOT_RESOLVED_BY_MATCHER]", {
          tenantId,
          input: value,
          matchedName: contextMatch.matchedName,
          contextConfidence: contextMatch.confidence,
          contextReason: contextMatch.reason,
          matcherResult: contextCandidateMatch.kind,
        });
      }
    } else if (contextMatch.kind === "ambiguous") {
      const ambiguousOptions = getSquareServicesByExactNames({
        services: servicesResult.services,
        names: contextMatch.candidateNames,
      });

      if (ambiguousOptions.length >= 2) {
        match = {
          kind: "ambiguous",
          options: ambiguousOptions,
        } as ReturnType<typeof resolveSquareServiceFromInput>;

        matchedInput = value;

        console.log("[VOICE_BOOKING][SQUARE_SERVICE_AMBIGUOUS_FROM_CONTEXT]", {
          tenantId,
          locale: currentLocale,
          originalInput: value,
          candidateNames: contextMatch.candidateNames,
          optionCount: ambiguousOptions.length,
          confidence: contextMatch.confidence,
          reason: contextMatch.reason,
        });
      } else {
        console.warn("[VOICE_BOOKING][SQUARE_CONTEXT_AMBIGUOUS_WITH_TOO_FEW_VALID_OPTIONS]", {
          tenantId,
          input: value,
          candidateNames: contextMatch.candidateNames,
          validOptionCount: ambiguousOptions.length,
        });
      }
    } else {
      console.warn("[VOICE_BOOKING][SQUARE_CONTEXT_MATCH_DID_NOT_RESOLVE]", {
        tenantId,
        input: value,
        reason: contextMatch.reason,
        confidence: contextMatch.confidence,
        matchedName: contextMatch.matchedName,
        candidateNames: contextMatch.candidateNames,
      });
    }
  }

  if (!match) {
    match = resolveSquareServiceFromInput({
      input: value,
      services: servicesResult.services,
      debug: true,
    });
  }

  if (!match || match.kind !== "resolved") {
    const ambiguityFromCandidates = findSquareServiceAmbiguityFromCandidates({
      services: servicesResult.services,
      inputCandidates: serviceInputCandidates,
    });

    if (ambiguityFromCandidates.kind === "ambiguous") {
      match = {
        kind: "ambiguous",
        options: ambiguityFromCandidates.options,
      } as ReturnType<typeof resolveSquareServiceFromInput>;

      matchedInput = value;

      console.log("[VOICE_BOOKING][SQUARE_SERVICE_AMBIGUOUS_FROM_CANDIDATES]", {
        tenantId,
        locale: currentLocale,
        originalInput: value,
        signalTokens: ambiguityFromCandidates.signalTokens,
        optionNames: ambiguityFromCandidates.optionNames,
      });
    }
  }

  if (match.kind === "resolved") {
    const resolvedServiceName = match.serviceName;

    const exactResolvedCandidate = hasExactResolvedServiceCandidate({
      inputCandidates: serviceInputCandidates,
      resolvedServiceName,
    });

    if (!exactResolvedCandidate) {
      const ambiguityGuard = findSquareServiceAmbiguityFromInput({
        services: servicesResult.services,
        inputCandidates: serviceInputCandidates,
        resolvedServiceName,
      });

      if (ambiguityGuard.kind === "ambiguous") {
        match = {
          kind: "ambiguous",
          options: ambiguityGuard.options,
        } as ReturnType<typeof resolveSquareServiceFromInput>;

        matchedInput = value;

        console.log("[VOICE_BOOKING][SQUARE_SERVICE_RESOLVED_OVERRIDDEN_TO_AMBIGUOUS]", {
          tenantId,
          locale: currentLocale,
          originalInput: value,
          previousResolvedServiceName: resolvedServiceName,
          signalTokens: ambiguityGuard.signalTokens,
          optionNames: ambiguityGuard.optionNames,
        });
      }
    } else {
      console.log("[VOICE_BOOKING][SQUARE_SERVICE_AMBIGUITY_GUARD_SKIPPED_EXACT_MATCH]", {
        tenantId,
        locale: currentLocale,
        originalInput: value,
        resolvedServiceName,
        inputCandidates: serviceInputCandidates,
      });
    }
  }

  if (match.kind === "resolved") {
    console.log("[VOICE_BOOKING][SQUARE_SERVICE_RESOLVED]", {
      tenantId,
      locale: currentLocale,
      originalInput: value,
      matchedInput,
      serviceName: match.serviceName,
      score: match.score,
    });

    const nextState = await applyResolvedSquareService({
      tenantId,
      connection: connectionResult.connection,
      currentIndex,
      rawAnswers,
      workingState,
      targetSlot,
      stepKey,
      input: matchedInput,
      service: match.service,
      serviceName: match.serviceName,
      score: match.score,
    });

    return {
      kind: "continue",
      workingState: nextState,
    };
  }

  const stateForRetry =
    match.kind === "ambiguous"
      ? setPendingSquareServiceChoice({
          state: workingState,
          input: matchedInput,
          options: match.options,
        })
      : workingState;

  const basePrompt = getLocalizedBookingStepPrompt({
    step: currentStep,
    locale: currentLocale,
    field: "retry_prompt",
    });

    const serviceOptions =
    match.kind === "ambiguous"
        ? match.options.map((service) => getSquareServiceName(service)).filter(Boolean)
        : servicesResult.services
            .slice(0, 8)
            .map((service) => getSquareServiceName(service))
            .filter(Boolean);

    const prompt =
    match.kind === "ambiguous"
        ? buildSquareAmbiguousServicePrompt({
            basePrompt,
            serviceOptions,
        })
        : basePrompt;

    return buildBookingServiceRetryResult({
    error:
        match.kind === "ambiguous"
        ? "AMBIGUOUS_BOOKING_SERVICE"
        : "UNRESOLVED_BOOKING_SERVICE",
    prompt,
    currentStep,
    currentIndex,
    currentLocale,
    workingState: stateForRetry,
    steps,
    serviceOptions,
    buildRealtimeBookingState,
  });
}