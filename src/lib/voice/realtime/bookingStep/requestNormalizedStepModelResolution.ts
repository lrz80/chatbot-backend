// src/lib/voice/realtime/bookingStep/requestNormalizedStepModelResolution.ts
import {
  PHONE_CONFIRM_REPLACE,
  PHONE_CONFIRM_UNKNOWN,
  PHONE_CONFIRM_USE_INBOUND,
} from "./resolvers/resolveRealtimePhoneValue";

const DATETIME_RESOLVED = "resolved";
const DATETIME_UNKNOWN = "unknown";

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

function isDatetimeStep(params: {
  pendingSlot: string;
  expectedType: string;
}): boolean {
  return (
    normalizeKey(params.pendingSlot) === "datetime" ||
    normalizeKey(params.expectedType) === "datetime"
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

    "Resolve the caller's latest answer into a booking confirmation protocol value.",
    "Use only the caller's latest answer.",
    "Do not guess.",
    "Do not invent missing data.",
    "Do not use earlier turns as the answer.",
    "Do not submit the caller's literal words for confirmation.",
    "",

    "Allowed protocol values:",
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
  ].join("\n");
}

function buildPhoneConfirmOrReplaceInstructions(params: {
  pendingBookingStepKey: string;
  pendingSlot: string;
  expectedType: string;
  validationMode: string;
  useInboundCaller: boolean;
  lastUserTranscript: string;
}): string {
  return [
    ...buildInternalSilenceRules(),

    "The caller answered a phone confirmation-or-replacement step.",
    `Current booking step key: ${params.pendingBookingStepKey}`,
    `Current booking slot: ${params.pendingSlot}`,
    `Current expected type: ${params.expectedType}`,
    `Current validation mode: ${params.validationMode}`,
    `Current use inbound caller phone: ${params.useInboundCaller ? "true" : "false"}`,
    `Caller latest answer: ${params.lastUserTranscript}`,
    "",

    "Resolve the caller's latest answer into a phone confirmation-or-replacement protocol value.",
    "Use only the caller's latest answer.",
    "Do not guess.",
    "Do not invent missing data.",
    "Do not use earlier turns as the answer.",
    "Do not submit the caller's literal words when they are only confirming or rejecting the current calling number.",
    "",

    "Allowed protocol values:",
    `- ${PHONE_CONFIRM_USE_INBOUND}: the caller clearly confirms that the current calling number is the best number to contact them.`,
    `- ${PHONE_CONFIRM_REPLACE}: the caller clearly rejects using the current calling number but does not provide a replacement phone number.`,
    `- ${PHONE_CONFIRM_UNKNOWN}: the caller's answer is unclear, unrelated, incomplete, noise, greeting, or not enough to confirm or replace the phone number.`,
    "",

    "Replacement phone rule:",
    "- If the caller clearly provides a different phone number, submit only the normalized replacement phone number.",
    "",

    "Tool call requirements:",
    "- tool: submit_booking_step",
    `- step_key: ${params.pendingBookingStepKey}`,
    `- value: ${PHONE_CONFIRM_USE_INBOUND} OR ${PHONE_CONFIRM_REPLACE} OR ${PHONE_CONFIRM_UNKNOWN} OR the normalized replacement phone number`,
    "Never use any previous step_key.",
    "Never use any previous date, time, service, name, phone, or old answer.",
  ].join("\n");
}

function buildDatetimeNormalizationInstructions(params: {
  pendingBookingStepKey: string;
  pendingSlot: string;
  expectedType: string;
  validationMode: string;
  lastUserTranscript: string;
}): string {
  return [
    ...buildInternalSilenceRules(),

    "The caller answered a booking datetime step.",
    `Current booking step key: ${params.pendingBookingStepKey}`,
    `Current booking slot: ${params.pendingSlot}`,
    `Current expected type: ${params.expectedType}`,
    `Current validation mode: ${params.validationMode}`,
    `Caller latest answer: ${params.lastUserTranscript}`,
    "",

    "Resolve the caller's latest answer into a datetime protocol JSON string.",
    "Use only the caller's latest answer.",
    "Do not guess.",
    "Do not invent missing date or time.",
    "Do not use earlier turns as the answer.",
    "Do not submit the caller's literal words if the answer is unclear, incomplete, unrelated, corrupted by transcription, or missing either date/day or time.",
    "",

    "Allowed protocol JSON shapes:",
    `- {"status":"${DATETIME_RESOLVED}","raw":"caller exact answer","date_text":"date phrase","time_text":"time phrase"}`,
    `- {"status":"${DATETIME_UNKNOWN}","raw":"caller exact answer"}`,
    "",

    "Rules:",
    `- Use status ${DATETIME_RESOLVED} only when the caller clearly provided both a date/day and a time.`,
    `- Use status ${DATETIME_UNKNOWN} when the answer is unclear, incomplete, unrelated, corrupted by transcription, or missing either date/day or time.`,
    "- If resolved, date_text must contain only the date/day phrase from the latest answer.",
    "- If resolved, time_text must contain only the time phrase from the latest answer.",
    "",

    "Tool call requirements:",
    "- tool: submit_booking_step",
    `- step_key: ${params.pendingBookingStepKey}`,
    "- value: the JSON string only",
    "Never use any previous step_key.",
    "Never use any previous date, time, service, name, phone, or old answer.",
  ].join("\n");
}

function buildDefaultNormalizationInstructions(params: {
  pendingBookingStepKey: string;
  pendingSlot: string;
  expectedType: string;
  validationMode: string;
  lastUserTranscript: string;
}): string {
  return [
    ...buildInternalSilenceRules(),

    "The caller answered the current booking step.",
    `Current booking step key: ${params.pendingBookingStepKey}`,
    `Current booking slot: ${params.pendingSlot}`,
    `Current expected type: ${params.expectedType}`,
    `Current validation mode: ${params.validationMode}`,
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
    "- If this is a phone-number step and the caller says a phone number, submit only the normalized phone number.",
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

  const phoneConfirmOrReplaceStep = isConfirmOrReplacePhoneStep({
    pendingSlot,
    expectedType,
    validationMode,
    useInboundCaller,
  });

  const datetimeStep = isDatetimeStep({
    pendingSlot,
    expectedType,
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
    isPhoneConfirmOrReplaceStep: phoneConfirmOrReplaceStep,
    isDatetimeStep: datetimeStep,
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
    : phoneConfirmOrReplaceStep
      ? buildPhoneConfirmOrReplaceInstructions({
          pendingBookingStepKey,
          pendingSlot,
          expectedType,
          validationMode,
          useInboundCaller,
          lastUserTranscript,
        })
      : datetimeStep
        ? buildDatetimeNormalizationInstructions({
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
            lastUserTranscript,
          });

  const responseSource = confirmationStep
    ? "booking_step_confirmation_model_resolution"
    : phoneConfirmOrReplaceStep
      ? "booking_step_phone_confirm_or_replace_model_resolution"
      : datetimeStep
        ? "booking_step_datetime_model_resolution"
        : "booking_step_normalized_model_resolution";

  params.requestRealtimeResponse(
    {
      instructions,
      tool_choice: "required",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: [
                "Internal booking step resolver input.",
                "",
                `Current booking step key: ${pendingBookingStepKey}`,
                `Current booking slot: ${pendingSlot}`,
                `Current expected type: ${expectedType}`,
                `Current validation mode: ${validationMode}`,
                `Current use inbound caller phone: ${useInboundCaller ? "true" : "false"}`,
                `Caller latest answer: ${lastUserTranscript}`,
                "",
                "Use only this input.",
                "Call submit_booking_step exactly once.",
                `The submit_booking_step step_key must be: ${pendingBookingStepKey}`,
              ].join("\n"),
            },
          ],
        },
      ],
    },
    responseSource
  );
}