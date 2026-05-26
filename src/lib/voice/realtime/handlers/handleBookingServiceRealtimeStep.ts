// src/lib/voice/realtime/handlers/handleBookingServiceRealtimeStep.ts
import type { CallState, VoiceLocale } from "../../types";
import { executeCanonicalBookingServiceStep } from "../../booking/handleBookingServiceStep";
import {
  buildCanonicalCallState,
  type BookingFlowStepLike,
  type BookingState,
} from "../realtimeBookingFlowUtils";
import { buildRealtimeNextRequiredStep } from "../bookingStep/buildRealtimeNextRequiredStep";
import { resolveTenantBookingProvider } from "../../../appointments/booking/providers/resolveTenantBookingProvider";
import { getSquareConnectionForTenant } from "../../../integrations/square/getSquareConnectionForTenant";
import {
  getSquareBookableServices,
  type SquareBookableService,
} from "../../../integrations/square/getSquareBookableServices";
import { upsertTenantExternalServiceMapping } from "../../../integrations/serviceMappings/getTenantExternalServiceMapping";

type HandleBookingServiceRealtimeStepParams = {
  tenantId: string;
  callerPhone: string | null;
  currentStep: BookingFlowStepLike;
  currentIndex: number;
  currentLocale: VoiceLocale;
  value: string;
  targetSlot: string;
  stepKey: string;
  rawAnswers: Record<string, string>;
  workingState: CallState;
  rawConfig: string;
  steps: BookingFlowStepLike[];
  buildRealtimeBookingState: (params: {
    steps: BookingFlowStepLike[];
    state: CallState;
    explicitCurrentIndex?: number | null;
    finalConfirmationGranted?: boolean;
    readyToCreate?: boolean;
  }) => BookingState;
};

type HandleBookingServiceRealtimeStepResult =
  | {
      kind: "return";
      result: any;
    }
  | {
      kind: "continue";
      workingState: CallState;
    };

type SquareServiceMatch =
  | {
      kind: "resolved";
      service: SquareBookableService;
      serviceName: string;
      score: number;
    }
  | {
      kind: "ambiguous";
      options: string[];
    }
  | {
      kind: "none";
    };

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeSearchText(value: unknown): string {
  return clean(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map(clean).filter(Boolean)));
}

function getLocalizedStepPrompt(
  step: BookingFlowStepLike,
  locale: VoiceLocale,
  field: "prompt" | "retry_prompt"
): string {
  const translationsField =
    field === "prompt" ? "prompt_translations" : "retry_prompt_translations";

  const translations = (step as any)?.[translationsField];

  if (
    translations &&
    typeof translations === "object" &&
    typeof translations[locale] === "string" &&
    translations[locale].trim()
  ) {
    return translations[locale].trim();
  }

  const directValue = clean((step as any)?.[field]);

  if (directValue) {
    return directValue;
  }

  return clean((step as any)?.prompt);
}

function getSquareServiceName(service: SquareBookableService): string {
  const anyService = service as any;

  const explicitServiceName = clean(anyService.serviceName);
  if (explicitServiceName) return explicitServiceName;

  const itemName = clean(service.itemName);
  const variationName = clean(service.variationName);

  if (!variationName) return itemName;

  if (itemName.toLowerCase() === variationName.toLowerCase()) {
    return itemName;
  }

  return `${itemName} ${variationName}`.trim();
}

function getSquareSearchText(service: SquareBookableService): string {
  const anyService = service as any;

  return uniqueStrings([
    clean(anyService.searchText),
    getSquareServiceName(service),
    clean(service.itemName),
    clean(service.variationName),
  ]).join(" | ");
}

function scoreCandidate(input: string, candidate: string): number {
  const normalizedInput = normalizeSearchText(input);
  const normalizedCandidate = normalizeSearchText(candidate);

  if (!normalizedInput || !normalizedCandidate) {
    return 0;
  }

  if (normalizedInput === normalizedCandidate) {
    return 1;
  }

  const inputTokens = uniqueStrings(normalizedInput.split(" "));
  const candidateTokens = uniqueStrings(normalizedCandidate.split(" "));

  if (inputTokens.length === 0 || candidateTokens.length === 0) {
    return 0;
  }

  const candidateTokenSet = new Set(candidateTokens);
  const inputTokenSet = new Set(inputTokens);

  const matchedInputTokens = inputTokens.filter((token) =>
    candidateTokenSet.has(token)
  );

  const matchedCandidateTokens = candidateTokens.filter((token) =>
    inputTokenSet.has(token)
  );

  const inputCoverage = matchedInputTokens.length / inputTokens.length;
  const candidateCoverage =
    matchedCandidateTokens.length / candidateTokens.length;

  const union = new Set([...inputTokens, ...candidateTokens]);
  const jaccard = matchedInputTokens.length / Math.max(union.size, 1);

  const containsFullInput = normalizedCandidate.includes(normalizedInput);
  const containsFullCandidate = normalizedInput.includes(normalizedCandidate);

  if (containsFullInput && inputTokens.length >= 2) {
    return 0.96;
  }

  if (containsFullCandidate && candidateTokens.length >= 2) {
    return 0.94;
  }

  const hasStrongEvidence =
    matchedInputTokens.length >= 2 ||
    inputCoverage >= 0.8 ||
    candidateCoverage >= 0.8;

  if (!hasStrongEvidence) {
    return 0;
  }

  return inputCoverage * 0.5 + candidateCoverage * 0.35 + jaccard * 0.15;
}

function resolveSquareServiceFromInput(params: {
  input: string;
  services: SquareBookableService[];
}): SquareServiceMatch {
  const input = clean(params.input);
  const normalizedInput = normalizeSearchText(input);

  if (!normalizedInput) {
    return { kind: "none" };
  }

  const scored = params.services
    .map((service) => {
      const serviceName = getSquareServiceName(service);
      const searchText = getSquareSearchText(service);
      const normalizedServiceName = normalizeSearchText(serviceName);
      const normalizedSearchText = normalizeSearchText(searchText);
      const score = scoreCandidate(input, searchText);

      return {
        service,
        serviceName,
        normalizedServiceName,
        normalizedSearchText,
        score,
      };
    })
    .filter((item) => item.serviceName && item.score > 0)
    .sort((a, b) => b.score - a.score);

  const best = scored[0];

  if (!best || best.score < 0.86) {
    return { kind: "none" };
  }

  const exactOrContainedMatches = scored.filter((item) => {
    return (
      item.normalizedServiceName === normalizedInput ||
      item.normalizedSearchText === normalizedInput ||
      item.normalizedServiceName.includes(normalizedInput) ||
      item.normalizedSearchText.includes(normalizedInput)
    );
  });

  if (exactOrContainedMatches.length === 1) {
    const only = exactOrContainedMatches[0];

    return {
      kind: "resolved",
      service: only.service,
      serviceName: only.serviceName,
      score: only.score,
    };
  }

  if (exactOrContainedMatches.length > 1) {
    return {
      kind: "ambiguous",
      options: exactOrContainedMatches
        .slice(0, 5)
        .map((item) => item.serviceName),
    };
  }

  const closeMatches = scored.filter((item) => best.score - item.score < 0.08);

  if (closeMatches.length !== 1) {
    return {
      kind: "ambiguous",
      options: closeMatches.slice(0, 5).map((item) => item.serviceName),
    };
  }

  return {
    kind: "resolved",
    service: best.service,
    serviceName: best.serviceName,
    score: best.score,
  };
}

async function resolveSquareBookingServiceStep(params: {
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
  buildRealtimeBookingState: HandleBookingServiceRealtimeStepParams["buildRealtimeBookingState"];
}): Promise<HandleBookingServiceRealtimeStepResult> {
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
    const bookingState = buildRealtimeBookingState({
      steps,
      state: workingState,
      explicitCurrentIndex: currentIndex,
    });

    const prompt = getLocalizedStepPrompt(
      currentStep,
      currentLocale,
      "retry_prompt"
    );

    const nextStepResult = buildRealtimeNextRequiredStep({
      steps,
      bookingState,
      locale: currentLocale,
      overridePrompt: prompt,
    });

    return {
      kind: "return",
      result: {
        ok: false,
        error: "SQUARE_CONNECTION_NOT_AVAILABLE",
        message: prompt,
        assistant_prompt: prompt,
        booking_state: bookingState,
        next_required_step: nextStepResult.ok
          ? nextStepResult.next_required_step
          : null,
        service_options: [],
      },
    };
  }

  const servicesResult = await getSquareBookableServices({
    accessToken: connectionResult.connection.accessToken,
    environment: connectionResult.connection.environment,
  });

  if (!servicesResult.ok) {
    const bookingState = buildRealtimeBookingState({
      steps,
      state: workingState,
      explicitCurrentIndex: currentIndex,
    });

    const prompt = getLocalizedStepPrompt(
      currentStep,
      currentLocale,
      "retry_prompt"
    );

    const nextStepResult = buildRealtimeNextRequiredStep({
      steps,
      bookingState,
      locale: currentLocale,
      overridePrompt: prompt,
    });

    return {
      kind: "return",
      result: {
        ok: false,
        error: servicesResult.error,
        message: prompt,
        assistant_prompt: prompt,
        booking_state: bookingState,
        next_required_step: nextStepResult.ok
          ? nextStepResult.next_required_step
          : null,
        service_options: [],
      },
    };
  }

  const match = resolveSquareServiceFromInput({
    input: value,
    services: servicesResult.services,
  });

  if (match.kind === "none" || match.kind === "ambiguous") {
    const bookingState = buildRealtimeBookingState({
      steps,
      state: workingState,
      explicitCurrentIndex: currentIndex,
    });

    const prompt = getLocalizedStepPrompt(
      currentStep,
      currentLocale,
      "retry_prompt"
    );

    const nextStepResult = buildRealtimeNextRequiredStep({
      steps,
      bookingState,
      locale: currentLocale,
      overridePrompt: prompt,
    });

    if (!nextStepResult.ok) {
      return {
        kind: "return",
        result: {
          ok: false,
          error: nextStepResult.error,
          step_key: nextStepResult.step_key,
          slot: nextStepResult.slot,
          prompt_error: nextStepResult.prompt_error,
          retry_prompt_error: nextStepResult.retry_prompt_error,
          message: "BOOKING_FLOW_CONFIGURATION_INVALID",
          booking_state: bookingState,
          next_required_step: null,
        },
      };
    }

    return {
      kind: "return",
      result: {
        ok: false,
        error:
          match.kind === "ambiguous"
            ? "AMBIGUOUS_BOOKING_SERVICE"
            : "UNRESOLVED_BOOKING_SERVICE",
        message: prompt,
        assistant_prompt: prompt,
        booking_state: bookingState,
        next_required_step: nextStepResult.next_required_step,
        service_options: match.kind === "ambiguous" ? match.options : [],
      },
    };
  }

  const service = match.service;
  const serviceName = match.serviceName;

  await upsertTenantExternalServiceMapping({
    tenantId,
    provider: "square",
    internalServiceKey: serviceName,
    externalServiceId: service.variationId,
    externalServiceVersion: service.variationVersion,
    externalLocationId:
      clean((connectionResult.connection as any).locationId) || null,
    externalMetadata: {
      source: "square_catalog",
      itemId: service.itemId,
      itemName: service.itemName,
      variationName: service.variationName,
      durationMinutes: service.durationMinutes,
      availableForBooking: service.availableForBooking,
      resolvedFromInput: value,
      matchScore: match.score,
    },
    isActive: true,
  });

  const nextAnswers = {
    ...rawAnswers,
    [targetSlot]: serviceName,
    [stepKey]: serviceName,
  };

  const nextState = buildCanonicalCallState({
    state: workingState,
    answersBySlot: nextAnswers,
    bookingStepIndex: currentIndex,
  }) as any;

  nextState.squareService = {
    provider: "square",
    serviceName,
    itemId: service.itemId,
    itemName: service.itemName,
    variationId: service.variationId,
    variationName: service.variationName,
    variationVersion: service.variationVersion,
    durationMinutes: service.durationMinutes,
  };

  return {
    kind: "continue",
    workingState: nextState,
  };
}

export async function handleBookingServiceRealtimeStep(
  params: HandleBookingServiceRealtimeStepParams
): Promise<HandleBookingServiceRealtimeStepResult> {
  const {
    tenantId,
    callerPhone,
    currentStep,
    currentIndex,
    currentLocale,
    value,
    targetSlot,
    stepKey,
    rawAnswers,
    workingState,
    rawConfig,
    steps,
    buildRealtimeBookingState,
  } = params;

  const provider = await resolveTenantBookingProvider(tenantId);

  if (provider === "square") {
    return resolveSquareBookingServiceStep({
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
    });
  }

  const serviceResult = await executeCanonicalBookingServiceStep({
    currentStep: currentStep as any,
    currentLocale,
    callerE164: callerPhone,
    effectiveUserInput: value,
    state: workingState,
    rawConfig,
  });

  if (serviceResult.kind === "retry" || serviceResult.kind === "ambiguous") {
    const bookingState = buildRealtimeBookingState({
      steps,
      state: workingState,
      explicitCurrentIndex: currentIndex,
    });

    const nextStepResult = buildRealtimeNextRequiredStep({
      steps,
      bookingState,
      locale: currentLocale,
      overridePrompt: serviceResult.prompt,
    });

    if (!nextStepResult.ok) {
      return {
        kind: "return",
        result: {
          ok: false,
          error: nextStepResult.error,
          step_key: nextStepResult.step_key,
          slot: nextStepResult.slot,
          prompt_error: nextStepResult.prompt_error,
          retry_prompt_error: nextStepResult.retry_prompt_error,
          message: "BOOKING_FLOW_CONFIGURATION_INVALID",
          booking_state: bookingState,
          next_required_step: null,
        },
      };
    }

    return {
      kind: "return",
      result: {
        ok: false,
        error:
          serviceResult.kind === "ambiguous"
            ? "AMBIGUOUS_BOOKING_SERVICE"
            : "UNRESOLVED_BOOKING_SERVICE",
        message: serviceResult.prompt,
        assistant_prompt: serviceResult.prompt,
        booking_state: bookingState,
        next_required_step: nextStepResult.next_required_step,
        service_options:
          serviceResult.kind === "ambiguous" ? serviceResult.options : [],
      },
    };
  }

  const nextAnswers = {
    ...rawAnswers,
    [targetSlot]: serviceResult.resolvedValue,
    [stepKey]: serviceResult.resolvedValue,
  };

  return {
    kind: "continue",
    workingState: buildCanonicalCallState({
      state: serviceResult.state,
      answersBySlot: nextAnswers,
      bookingStepIndex: currentIndex,
    }),
  };
}