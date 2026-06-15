// src/lib/voice/realtime/bookingStep/requestNormalizedStepModelResolution.ts
import { USE_CALLER_PHONE_TOKEN } from "./resolvers/resolveRealtimePhoneValue";

type RequestRealtimeResponse = (
  response?: Record<string, unknown>,
  source?: string
) => void;

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeKey(value: unknown): string {
  return clean(value).toLowerCase();
}

function isConfirmationStep(params: {
  pendingBookingStepKey: string;
  pendingSlot: string;
  expectedType: string;
  validationMode: string;
}): boolean {
  const pendingBookingStepKey = normalizeKey(params.pendingBookingStepKey);
  const pendingSlot = normalizeKey(params.pendingSlot);
  const expectedType = normalizeKey(params.expectedType);
  const validationMode = normalizeKey(params.validationMode);

  return (
    pendingBookingStepKey === "confirm" ||
    pendingBookingStepKey === "confirmation" ||
    pendingSlot === "confirmation" ||
    expectedType === "confirmation" ||
    validationMode === "confirmation"
  );
}

function isConfirmOrReplacePhoneStep(params: {
  expectedType: string;
  pendingSlot: string;
  validationMode: string;
  useInboundCaller: boolean;
}): boolean {
  const expectedType = normalizeKey(params.expectedType);
  const pendingSlot = normalizeKey(params.pendingSlot);
  const validationMode = normalizeKey(params.validationMode);

  return (
    expectedType === "phone" &&
    pendingSlot === "customer_phone" &&
    validationMode === "confirm_or_replace" &&
    params.useInboundCaller === true
  );
}

function buildInternalSilenceRules(): string[] {
  return [
    "Internal tool-routing task. Do not speak to the caller.",
    "Do not produce audio.",
    "Do not answer conversationally.",
    "Do not ask a question.",
    "Do not say anything to the caller.",
    "Do not explain anything.",
    "Do not make availability-related comments.",
    "Never say you are reviewing availability.",
    "Never say a time is available or unavailable.",
    "Never call get_booking_flow.",
    "",
  ];
}

function buildConfirmationNormalizationInstructions(params: {
  pendingBookingStepKey: string;
  pendingSlot: string;
  expectedType: string;
  validationMode: string;
  lastUserTranscript: string;
}): string {
  return [
    ...buildInternalSilenceRules(),

    "The caller answered the current booking confirmation step.",
    `Current booking step key: ${params.pendingBookingStepKey}`,
    `Current booking slot: ${params.pendingSlot}`,
    `Current expected type: ${params.expectedType}`,
    `Current validation mode: ${params.validationMode}`,
    `Caller latest answer: ${params.lastUserTranscript}`,
    "",

    "Resolve the caller's latest answer into a booking confirmation intent.",
    "Use only the caller's latest answer.",
    "Do not guess.",
    "Do not invent missing data.",
    "Do not use earlier turns as the answer.",
    "Do not submit the caller's literal words for confirmation.",
    "",

    "Allowed confirmation values:",
    "- confirm: the caller clearly approves creating the appointment.",
    "- cancel: the caller clearly rejects, cancels, or says the booking is not correct.",
    "- unknown: the caller's answer is unclear, unrelated, incomplete, noise, greeting, or not enough to confirm/cancel.",
    "",

    "Tool call requirements:",
    "- tool: submit_booking_step",
    `- step_key: ${params.pendingBookingStepKey}`,
    "- value: confirm OR cancel OR unknown",
    "Never use any previous step_key.",
    "Never use any previous date, time, service, name, phone, or old answer.",
    "",

    "Use confirm only when clear.",
    "Use cancel only when clear.",
    "Use unknown for anything unclear.",
  ].join("\n");
}

function buildDefaultNormalizationInstructions(params: {
  pendingBookingStepKey: string;
  pendingSlot: string;
  expectedType: string;
  validationMode: string;
  useInboundCaller: boolean;
  lastUserTranscript: string;
}): string {
  const confirmOrReplacePhoneStep = isConfirmOrReplacePhoneStep({
    expectedType: params.expectedType,
    pendingSlot: params.pendingSlot,
    validationMode: params.validationMode,
    useInboundCaller: params.useInboundCaller,
  });

  const phoneRules = confirmOrReplacePhoneStep
    ? [
        "- This is a phone-number confirmation step using the inbound caller phone.",
        `- If the caller clearly confirms using the current calling number, submit exactly this token as the value: ${USE_CALLER_PHONE_TOKEN}`,
        "- Confirmation examples include: yes, yeah, yep, si, sí, sì, correcto, correct, ok, okay, confirmo.",
        "- If the caller says a different phone number, submit only the normalized phone number.",
        "- If the caller says no but does not provide another phone number, submit the caller's latest answer exactly as heard. Let the backend reject it and return the retry prompt.",
      ]
    : [
        "- If this is a phone-number step and the caller says a phone number, submit only the normalized phone number.",
        "- Do not submit the caller-phone token unless the current validation mode is confirm_or_replace and inbound caller phone usage is enabled.",
      ];

  return [
    ...buildInternalSilenceRules(),

    "The caller answered the current booking step.",
    `Current booking step key: ${params.pendingBookingStepKey}`,
    `Current booking slot: ${params.pendingSlot}`,
    `Current expected type: ${params.expectedType}`,
    `Current validation mode: ${params.validationMode}`,
    `Current use inbound caller phone: ${params.useInboundCaller ? "true" : "false"}`,
    `Caller latest answer: ${params.lastUserTranscript}`,
    "",

    "You must call submit_booking_step exactly once.",
    "Do not produce a spoken or written answer.",
    "Do not respond to the caller.",
    "Only call the tool.",
    "Normalize the caller's latest answer only if needed.",
    "Use only the caller's latest answer.",
    "Do not guess.",
    "Do not invent missing data.",
    "Do not use earlier turns as the answer.",
    "",

    "Rules:",
    "- If this is an address step, convert spoken numbers into address digits when clear.",
    ...phoneRules,
    "- If this is an email step, normalize the email only if the caller clearly said one.",
    "- If the latest answer does not clearly answer this step, still call submit_booking_step with the caller's latest answer exactly as heard. Let the backend reject it and return the retry prompt.",
    "",

    "Tool call requirements:",
    "- tool: submit_booking_step",
    `- step_key: ${params.pendingBookingStepKey}`,
    "- value: the normalized answer if clear, otherwise the caller's latest answer exactly as heard.",
    "Never use any previous step_key.",
    "Never use any previous date, time, service, name, phone, or old answer.",
  ].join("\n");
}

export function requestNormalizedStepModelResolution(params: {
  callSid: string | null;
  source: string;
  pendingBookingStepKey: string;
  pendingSlot: string;
  expectedType: string;
  validationMode: string;
  useInboundCaller?: boolean;
  lastUserTranscript: string;
  lastUserTranscriptSeq: number;
  pendingBookingStepPromptAnchorSeq: number;
  requestRealtimeResponse: RequestRealtimeResponse;
}): void {
  const pendingBookingStepKey = clean(params.pendingBookingStepKey);
  const pendingSlot = clean(params.pendingSlot);
  const expectedType = clean(params.expectedType);
  const validationMode = clean(params.validationMode);
  const useInboundCaller = params.useInboundCaller === true;
  const lastUserTranscript = clean(params.lastUserTranscript);

  if (!pendingBookingStepKey || !lastUserTranscript) {
    return;
  }

  const confirmationStep = isConfirmationStep({
    pendingBookingStepKey,
    pendingSlot,
    expectedType,
    validationMode,
  });

  console.warn("[VOICE_REALTIME][NORMALIZED_STEP_MODEL_RESOLUTION_REQUESTED]", {
    callSid: params.callSid,
    source: params.source,
    pendingBookingStepKey,
    pendingSlot,
    expectedType,
    validationMode,
    useInboundCaller,
    isConfirmationStep: confirmationStep,
    lastUserTranscript,
    lastUserTranscriptSeq: params.lastUserTranscriptSeq,
    pendingBookingStepPromptAnchorSeq: params.pendingBookingStepPromptAnchorSeq,
  });

  const instructions = confirmationStep
    ? buildConfirmationNormalizationInstructions({
        pendingBookingStepKey,
        pendingSlot,
        expectedType,
        validationMode,
        lastUserTranscript,
      })
    : buildDefaultNormalizationInstructions({
        pendingBookingStepKey,
        pendingSlot,
        expectedType,
        validationMode,
        useInboundCaller,
        lastUserTranscript,
      });

  params.requestRealtimeResponse(
    {
      instructions,
      tool_choice: "required",
    },
    confirmationStep
      ? "booking_step_confirmation_model_resolution"
      : "booking_step_normalized_model_resolution"
  );
}