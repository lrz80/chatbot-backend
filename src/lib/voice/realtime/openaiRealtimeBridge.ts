// src/lib/voice/realtime/openaiRealtimeBridge.ts

import WebSocket from "ws";
import type { CallState, VoiceLocale } from "../types";

import {
  attachLatestUserTranscriptSeq,
  mergeTranscriptStatePreservingBookingRuntime,
} from "./bookingRuntimeState";
import { handleRealtimeUserTranscript } from "./handleRealtimeUserTranscript";
import { handleRealtimeResponseDone } from "./handleRealtimeResponseLifecycle";
import { createRealtimeResponseController } from "./realtimeResponseController";
import {
  endTwilioCall,
  isTwilioMediaEvent,
  isTwilioStartEvent,
  isTwilioStopEvent,
  sendTwilioAudio,
  type TwilioUnknownPayload,
} from "./twilioRealtimeTransport";
import {
  buildInitialGreetingFromConfiguredWelcome,
  buildRealtimeSessionUpdatePayload,
  refreshRealtimeSession,
  refreshRealtimeVoiceContext,
  resolveConfiguredWelcomeMessage,
  resolveInitialRealtimeSessionContext,
} from "./realtimeSessionManager";
import { createBookingRealtimeCoordinator } from "./bookingRealtimeCoordinator";
import {
  getOpenAiRealtimeUrl,
  isConversationAlreadyHasActiveResponseError,
  isOpenAiRealtimeAssistantTranscriptDone,
  isResponseCancelNotActiveError,
  resolveOpenAiRealtimeAssistantTranscriptDelta,
  resolveOpenAiRealtimeAssistantTranscriptDone,
  resolveOpenAiRealtimeAudioDelta,
  safeJsonParseRealtimeEvent,
} from "./openAiRealtimeEvents";
import { createRealtimeToolCallQueue } from "./realtimeToolCallQueue";
import { createRealtimeBargeInController } from "./realtimeBargeInController";
import { createHumanTransferController } from "./humanTransferController";
import { saveAndEmitMessage } from "../../messages/saveAndEmitMessage";
import { upsertVoiceSalesIntelligence } from "../../salesIntelligence/upsertVoiceSalesIntelligence";
import {
  recordVoiceCallStarted,
  recordVoiceCallEnded,
} from "./voiceCallRecorder";
import {
  buildReturningCustomerGreetingInput,
  resolveReturningCustomer,
} from "../returningCustomer";

type BridgeParams = {
  twilioSocket: WebSocket;
};

function sendJson(socket: WebSocket, payload: Record<string, unknown>): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(payload));
}

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function isInternalModelResolutionSource(source: unknown): boolean {
  const value = clean(source);

  return (
    value.startsWith("booking_step_") &&
    value.endsWith("_model_resolution")
  );
}

function resolveGoodbyeHangupFallbackMs(transcript: string): number {
  const configured = Number(process.env.REALTIME_GOODBYE_HANGUP_FALLBACK_MS);

  if (Number.isFinite(configured) && configured >= 2000) {
    return Math.min(configured, 15000);
  }

  const words = clean(transcript).split(/\s+/).filter(Boolean).length;

  /**
   * Approximate spoken goodbye duration.
   * This is only a fallback. The primary signal is Twilio's mark event.
   */
  const estimatedSpeechMs = Math.ceil((words / 2.4) * 1000);

  return Math.min(Math.max(estimatedSpeechMs + 1800, 3500), 10000);
}

function sendTwilioMark(params: {
  twilioSocket: WebSocket;
  streamSid: string | null;
  markName: string;
}): boolean {
  if (!params.streamSid) return false;
  if (params.twilioSocket.readyState !== WebSocket.OPEN) return false;

  sendJson(params.twilioSocket, {
    event: "mark",
    streamSid: params.streamSid,
    mark: {
      name: params.markName,
    },
  });

  return true;
}

function normalizeAssistantPromptText(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[¿?¡!.,;:]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractExactBookingPromptFromInstructions(
  instructions: unknown
): string {
  const text = clean(instructions);

  const marker = "Booking prompt:";
  const markerIndex = text.lastIndexOf(marker);

  if (markerIndex < 0) {
    return "";
  }

  return clean(text.slice(markerIndex + marker.length));
}

function isExactBookingPromptResponseSource(source: unknown): boolean {
  const value = clean(source);

  return (
    value === "tool_followup:get_booking_flow" ||
    value === "tool_followup:submit_booking_step" ||
    value === "tool_followup:submit_booking_step:retry" ||
    value === "tool_followup:submit_booking_step:exact_retry"
  );
}

function isAssistantTranscriptCompatibleWithExpectedPrompt(params: {
  transcript: string;
  expectedPrompt: string;
}): boolean {
  const transcript = normalizeAssistantPromptText(params.transcript);
  const expectedPrompt = normalizeAssistantPromptText(params.expectedPrompt);

  if (!transcript || !expectedPrompt) {
    return true;
  }

  return expectedPrompt.startsWith(transcript);
}

export async function createOpenAiRealtimeBridge({
  twilioSocket,
}: BridgeParams): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY");
  }

  let streamSid: string | null = null;
  let callSid: string | null = null;
  let didNumber: string | null = null;
  let callerPhone: string | null = null;
  let tenantId: string | null = null;
  let realtimeTenant: any = null;
  let realtimeCfg: any = null;
  let realtimeState: CallState = {};
  let lastUserTranscript = "";
  let lastUserDigits = "";
  let lastUserTranscriptSeq = 0;
  let openAiReady = false;
  let sessionConfigured = false;
  let currentLocale: VoiceLocale = "en-US";
  let bookingFlowLoaded = false;

  let assistantSpeaking = false;
  let lastAssistantAudioDeltaAtMs = 0;
  let lastAssistantAudioDoneAtMs = 0;
  let currentAssistantTranscript = "";
  let lastAssistantTranscript = "";
  let suppressActiveAssistantAudio = false;
  let expectedAssistantPromptForActiveResponse = "";
  let exactPromptViolationHandledForActiveResponse = false;
  let pendingExactPromptRetry = false;
  let cancelledExactPromptResponseId: string | null = null;
  let didLogSuppressedAudioForActiveResponse = false;
  let didLogInternalModelResolutionAudioSuppressed = false;

  let hangupRequestedByTool = false;
  let endCallGoodbyeRequested = false;
  let endCallGoodbyeResponseId: string | null = null;

  let goodbyePlaybackMarkName: string | null = null;
  let goodbyeHangupFallbackTimer: NodeJS.Timeout | null = null;

  let callEnding = false;

  let localeLocked = false;
  let twilioAccountSid: string | null = null;

  const i18nBookingPromptsEnabled =
    process.env.VOICE_BOOKING_I18N_PROMPTS_ENABLED === "true";

  const model = process.env.OPENAI_REALTIME_MODEL?.trim() || "gpt-realtime";

  const openAiSocket = new WebSocket(getOpenAiRealtimeUrl(model), {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  const responseController = createRealtimeResponseController({
    openAiSocket,
    twilioSocket,
    getCallSid: () => callSid,
    getStreamSid: () => streamSid,
  });

  const bargeInController = createRealtimeBargeInController({
    openAiSocket,
    twilioSocket,
    responseController,
    getCallSid: () => callSid,
    getStreamSid: () => streamSid,
    getCallEnding: () => callEnding,
    getAssistantSpeaking: () => assistantSpeaking,
    setAssistantSpeaking: (value) => {
      assistantSpeaking = value;
    },
    getLastAssistantAudioDeltaAtMs: () => lastAssistantAudioDeltaAtMs,
    setLastAssistantAudioDoneAtMs: (value) => {
      lastAssistantAudioDoneAtMs = value;
    },

    getBookingTurnStatus: () =>
      clean((realtimeState as any).bookingTurnStatus),

    getPendingBookingStepKey: () =>
      clean((realtimeState as any).pendingBookingStepKey),
  });

  const toolCallQueue = createRealtimeToolCallQueue({
    openAiSocket,
    requestRealtimeResponse,

    getCallSid: () => callSid,
    getTenantId: () => tenantId,
    getCallerPhone: () => callerPhone,
    getDidNumber: () => didNumber,
    getTwilioAccountSid: () => twilioAccountSid,
    getRealtimeTenant: () => realtimeTenant,
    getRealtimeCfg: () => realtimeCfg,
    getRealtimeState: () => realtimeState,
    getCurrentLocale: () => currentLocale,
    getBookingFlowLoaded: () => bookingFlowLoaded,
    getCallEnding: () => callEnding,
    getLastUserTranscript: () => lastUserTranscript,
    getLastUserTranscriptSeq: () => lastUserTranscriptSeq,
    getLastUserDigits: () => lastUserDigits,

    setRealtimeState: (state) => {
      realtimeState = state;
    },
    setBookingFlowLoaded: (value) => {
      bookingFlowLoaded = value;
    },
    setHangupRequestedByTool: (value) => {
      hangupRequestedByTool = value;
    },
    setCallEnding: (value) => {
      callEnding = value;
    },
    resetLastUserDigits: () => {
      lastUserDigits = "";
    },
  });

  const humanTransferController =
  createHumanTransferController({
    twilioSocket,

    getStreamSid: () => streamSid,
    getCallSid: () => callSid,
    getTwilioAccountSid: () => twilioAccountSid,
    getCurrentLocale: () => currentLocale,
    getRealtimeState: () => realtimeState,
    getLastAssistantTranscript: () =>
      lastAssistantTranscript,
    getCallEnding: () => callEnding,

    setRealtimeState: (state) => {
      realtimeState = state;
    },

    setCallEnding: (value) => {
      callEnding = value;
    },

    requestRealtimeResponse,
  });

  const bookingCoordinator = createBookingRealtimeCoordinator({
    getCallSid: () => callSid,
    getRealtimeState: () => realtimeState,
    getLastUserTranscript: () => lastUserTranscript,
    getLastUserTranscriptSeq: () => lastUserTranscriptSeq,
    enqueueSubmitBookingStepFromTranscript:
      toolCallQueue.enqueueSubmitBookingStepFromTranscript,
    requestRealtimeResponse,
  });

  function performTwilioHangup(source: string): void {
    if (goodbyeHangupFallbackTimer) {
      clearTimeout(goodbyeHangupFallbackTimer);
      goodbyeHangupFallbackTimer = null;
    }

    if (!callEnding) {
      callEnding = true;
    }

    console.log("[VOICE_REALTIME][TWILIO_HANGUP_EXECUTING]", {
      callSid,
      source,
    });

    void recordVoiceCallEnded({
      tenantId,
      callSid,
      source,
    });

    endTwilioCall({
      callSid,
      accountSid: twilioAccountSid,
    }).catch((error) => {
      console.error("[VOICE_REALTIME][TWILIO_HANGUP_ERROR]", {
        callSid,
        accountSid: twilioAccountSid,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  function scheduleTwilioHangupAfterGoodbye(source: string): void {
    if (callEnding) return;

    hangupRequestedByTool = false;
    endCallGoodbyeRequested = false;
    endCallGoodbyeResponseId = null;

    const markName = `goodbye:${Date.now()}`;
    goodbyePlaybackMarkName = markName;

    const markSent = sendTwilioMark({
      twilioSocket,
      streamSid,
      markName,
    });

    const fallbackMs = resolveGoodbyeHangupFallbackMs(lastAssistantTranscript);

    console.log("[VOICE_REALTIME][TWILIO_HANGUP_SCHEDULED_AFTER_GOODBYE]", {
      callSid,
      source,
      markName,
      markSent,
      fallbackMs,
      lastAssistantTranscript,
    });

    goodbyeHangupFallbackTimer = setTimeout(() => {
      performTwilioHangup("goodbye_mark_fallback_timeout");
    }, fallbackMs);

    /**
     * Do not set callEnding=true yet.
     * Twilio may still be playing the goodbye audio already queued.
     * We only mark callEnding when Twilio confirms playback via mark,
     * or when the fallback timeout fires.
     */
  }

  function requestRealtimeResponse(
    response?: Record<string, unknown>,
    source = "unknown",
    options: {
      sendToolOutputToOpenAi?: boolean;
      endCallGoodbye?: boolean;
    } = {}
  ): void {
    const normalizedSource = clean(source);

    const bookingTurnStatus = clean((realtimeState as any).bookingTurnStatus);
    const pendingBookingStepKey = clean((realtimeState as any).pendingBookingStepKey);

    const hasActiveBookingTurn =
      Boolean(pendingBookingStepKey) &&
      (
        bookingTurnStatus === "waiting_user_answer" ||
        bookingTurnStatus === "waiting_assistant_prompt"
      );

    if (
      normalizedSource === "bridge:user_transcript_followup" &&
      hasActiveBookingTurn
    ) {
      console.warn("[VOICE_REALTIME][USER_TRANSCRIPT_FOLLOWUP_BLOCKED_DURING_BOOKING]", {
        callSid,
        source: normalizedSource,
        pendingBookingStepKey,
        bookingTurnStatus,
        lastUserTranscript,
        lastUserTranscriptSeq,
      });

      return;
    }

    const event: Record<string, unknown> = {
      type: "response.create",
      ...(response ? { response } : {}),
    };

    const responseInstructions =
      typeof response?.instructions === "string" ? response.instructions : "";

    const expectedBookingPromptFromInstructions =
      isExactBookingPromptResponseSource(normalizedSource)
        ? extractExactBookingPromptFromInstructions(responseInstructions)
        : "";

    const isEndCallFollowup = normalizedSource === "tool_followup:end_call";

    const shouldCreateEndCallGoodbye =
      isEndCallFollowup && options.endCallGoodbye === true;

    const shouldInterruptActiveResponse =
      normalizedSource === "tool_followup:get_booking_flow" ||
      normalizedSource.startsWith("tool_followup:submit_booking_step") ||
      normalizedSource === "tool_followup:end_call";

    if (isEndCallFollowup && shouldCreateEndCallGoodbye) {
      endCallGoodbyeRequested = true;
      endCallGoodbyeResponseId = null;
    }

    if (isEndCallFollowup && !shouldCreateEndCallGoodbye) {
      endCallGoodbyeRequested = false;
      endCallGoodbyeResponseId = null;

      console.log("[VOICE_REALTIME][END_CALL_FOLLOWUP_NOT_GOODBYE]", {
        callSid,
        source: normalizedSource,
      });
    }

    if (expectedBookingPromptFromInstructions) {
      expectedAssistantPromptForActiveResponse =
        expectedBookingPromptFromInstructions;

      console.warn("[VOICE_REALTIME][EXPECTED_ASSISTANT_PROMPT_ARMED]", {
        callSid,
        source: normalizedSource,
        expectedAssistantPromptForActiveResponse,
      });
    }

    responseController.requestRealtimeResponse({
      event,
      source: normalizedSource,
      shouldInterruptActiveResponse,
      startedAtUserTranscriptSeq: lastUserTranscriptSeq,
      sendToolOutputToOpenAi: options.sendToolOutputToOpenAi !== false,
    });
  }

  async function configureRealtimeSessionIfReady(): Promise<void> {
    if (sessionConfigured) return;
    if (!openAiReady) return;
    if (!callSid) return;
    if (!didNumber) return;
    if (openAiSocket.readyState !== WebSocket.OPEN) return;

    /**
     * Primero resolvemos el tenant con la infraestructura existente.
     * No cambiamos realtimeSessionManager ni el booking.
     */
    const context = await resolveInitialRealtimeSessionContext({
      callSid,
      didNumber,
      realtimeState,
    });

    if (!context.ok) {
      console.warn("[VOICE_REALTIME][CONTEXT_BLOCKED]", {
        callSid,
        didNumber,
      });

      twilioSocket.close();
      return;
    }

    /**
     * Módulo independiente de clientes recurrentes.
     *
     * Una falla, contacto inexistente o datos incompletos nunca bloquean
     * la llamada: simplemente se utiliza la bienvenida normal.
     */
    const returningCustomerResult =
      await resolveReturningCustomer({
        tenantId: context.tenantId,
        callerPhone,
      });

    const returningCustomer =
      returningCustomerResult.isReturningCustomer
        ? returningCustomerResult
        : null;

    /**
     * Un cliente recurrente comienza en el idioma guardado en su contacto.
     * No existe una lista fija de idiomas.
     *
     * Un cliente no recurrente conserva el comportamiento anterior.
     */
    currentLocale =
      clean(returningCustomer?.language) || "en-US";

    const sessionUpdatePayload =
      buildRealtimeSessionUpdatePayload({
        businessName: context.brand,
        businessInfo:
          context.tenant.info_clave || "",
        systemPrompt:
          context.cfg.system_prompt || "",
        locale: currentLocale,
        model,
      });

    if (openAiSocket.readyState !== WebSocket.OPEN) return;
    if (twilioSocket.readyState !== WebSocket.OPEN) return;

    sendJson(openAiSocket, sessionUpdatePayload);

    if (openAiSocket.readyState !== WebSocket.OPEN) return;
    if (twilioSocket.readyState !== WebSocket.OPEN) return;

    if (returningCustomer) {
      const greetingInput =
        buildReturningCustomerGreetingInput({
          customer: returningCustomer,
          businessName: context.brand,
        });

      console.log(
        "[VOICE_REALTIME][RETURNING_CUSTOMER_GREETING_SELECTED]",
        {
          callSid,
          tenantId: context.tenantId,
          contactId:
            returningCustomer.contactId,
          firstName:
            returningCustomer.firstName,
          fullName:
            returningCustomer.fullName,
          language:
            returningCustomer.language,
          reservations:
            returningCustomer.reservations,
        }
      );

      requestRealtimeResponse(
        {
          conversation: "none",
          tool_choice: "none",

          metadata: {
            purpose:
              "returning_customer_initial_greeting",
            contact_id: String(
              returningCustomer.contactId
            ),
            language: String(
              returningCustomer.language
            ),
          },

          instructions: [
            "You are producing the first spoken greeting for a live business phone call.",

            `The caller's stored language is: ${greetingInput.language}.`,
            "Speak the entire greeting naturally in that language.",
            "Do not default to English when a stored language is provided.",
            "Do not switch languages during the greeting.",

            `Address the caller using only this first name: ${greetingInput.firstName}.`,
            "Do not say the caller's last name.",
            "Sound warm, familiar, and conversational, like a helpful receptionist who recognizes a returning customer.",
            "Do not sound formal, scripted, robotic, or overly enthusiastic.",
            "Naturally acknowledge that it is good to speak with the caller again.",
            "Use a conversational transition such as the equivalent of 'Cuéntame' or 'Dime' in the caller's stored language.",
            "Ask naturally what the caller would like help with today.",

            "Use no more than two short conversational sentences.",
            "Do not mention CRM, records, call history, reservations, appointments, or previous services.",
            "Do not start a booking.",
            "Do not ask for the caller's name, phone number, service, date, or time.",
            "Do not invent information.",
          ].join("\n"),

          input: [
            {
              type: "message",
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: JSON.stringify({
                    intent:
                      greetingInput.intent,
                    firstName:
                      greetingInput.firstName,
                    businessName:
                      greetingInput.businessName,
                    language:
                      greetingInput.language,
                  }),
                },
              ],
            },
          ],
        },
        "bridge:returning_customer_greeting"
      );
    } else {
      /**
       * Cliente nuevo o contacto que no cumple los requisitos:
       * conserva exactamente la bienvenida anterior del dashboard.
       */
      const configuredWelcomeMessage =
        resolveConfiguredWelcomeMessage({
          cfg: context.cfg || {},
          tenant: context.tenant || {},
        });

      const fallbackGreetingText =
        buildInitialGreetingFromConfiguredWelcome({
          configuredWelcome: "",
          brand: context.brand,
          locale: currentLocale,
        });

      const initialGreetingText =
        clean(configuredWelcomeMessage) ||
        clean(fallbackGreetingText);

      console.log(
        "[VOICE_REALTIME][INITIAL_GREETING_SELECTED]",
        {
          callSid,
          tenantId: context.tenantId,
          brand: context.brand,
          configuredWelcomeLength:
            configuredWelcomeMessage.length,
          initialGreetingLength:
            initialGreetingText.length,
          returningCustomerReason:
            returningCustomerResult.isReturningCustomer
              ? null
              : returningCustomerResult.reason,
          hasSpanishLine:
            initialGreetingText
              .toLowerCase()
              .includes("español") ||
            initialGreetingText
              .toLowerCase()
              .includes("espanol"),
        }
      );

      requestRealtimeResponse(
        {
          conversation: "none",
          tool_choice: "none",

          metadata: {
            purpose: "initial_greeting",
            expected_prompt:
              initialGreetingText,
          },

          instructions: [
            "You are a speech renderer for a live phone call.",
            "Speak exactly the greeting provided in the input.",
            "Do not use conversation history.",
            "Do not reason.",
            "Do not translate.",
            "Do not summarize.",
            "Do not add words.",
            "Do not remove words.",
          ].join("\n"),

          input: [
            {
              type: "message",
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: [
                    "Speak exactly this greeting and nothing else:",
                    "",
                    initialGreetingText,
                  ].join("\n"),
                },
              ],
            },
          ],
        },
        "bridge:initial_greeting"
      );
    }

    /**
     * A partir de aquí permanece exactamente la infraestructura anterior.
     */
    tenantId = context.tenantId;
    realtimeTenant = context.tenant;
    realtimeCfg = context.cfg || {};

    realtimeState = {
      ...realtimeState,
      lang: currentLocale,

      returningCustomer: Boolean(returningCustomer),

      returningCustomerContactId:
        returningCustomer?.contactId ?? null,

      returningCustomerName:
        clean(returningCustomer?.fullName) || null,

      returningCustomerFirstName:
        clean(returningCustomer?.firstName) || null,

      returningCustomerPhone:
        clean(returningCustomer?.phone) || null,

      returningCustomerLocale:
        clean(returningCustomer?.language) || null,

      bookingData: returningCustomer
        ? {
            ...(realtimeState.bookingData || {}),
            customer_name: clean(returningCustomer.fullName),
            customer_phone: clean(returningCustomer.phone),
          }
        : {
            ...(realtimeState.bookingData || {}),
          },
    };

    console.log(
      "[VOICE_REALTIME][RETURNING_CUSTOMER_RUNTIME_ATTACHED]",
      {
        callSid,
        tenantId: context.tenantId,
        returningCustomer:
          realtimeState.returningCustomer === true,
        contactId:
          realtimeState.returningCustomerContactId ?? null,
        customerName:
          realtimeState.returningCustomerName ?? null,
        hasCustomerPhone:
          Boolean(realtimeState.returningCustomerPhone),
      }
    );

    void recordVoiceCallStarted({
      tenantId,
      callSid,
      fromNumber: callerPhone,
      toNumber: didNumber,
    });

    void upsertVoiceSalesIntelligence({
      tenantId,
      callSid,
      phone: callerPhone,
      bookingData: {
        call_started: true,
        from_number: callerPhone,
        to_number: didNumber,
        tenant_name:
          clean(context.tenant?.name),
      },
      outcome: "voice_call_started",
    }).catch((error) => {
      console.error(
        "[SALES_INTELLIGENCE][VOICE_CALL_STARTED_ERROR]",
        {
          tenantId,
          callSid,
          phone: callerPhone,
          error:
            error instanceof Error
              ? error.message
              : String(error),
        }
      );
    });

    sessionConfigured = true;
  }

  openAiSocket.on("open", () => {
    openAiReady = true;

    configureRealtimeSessionIfReady().catch((error) => {
      console.error("[VOICE_REALTIME][SESSION_CONFIG_ERROR]", error);
      twilioSocket.close();
    });
  });

  openAiSocket.on("message", (raw) => {
    const event = safeJsonParseRealtimeEvent(raw);

    if (!event) return;

    if (event.type === "input_audio_buffer.speech_started") {
      bargeInController.interruptAssistantAudio(
        "input_audio_buffer.speech_started"
      );
      return;
    }

    if (event.type === "response.created") {
      const responseState = responseController.markResponseCreated({
        responseId: event.response?.id || null,
        startedAtUserTranscriptSeq: lastUserTranscriptSeq,
      });

      assistantSpeaking = true;

      currentAssistantTranscript = "";
      lastAssistantTranscript = "";
      suppressActiveAssistantAudio = false;
      exactPromptViolationHandledForActiveResponse = false;
      pendingExactPromptRetry = false;
      didLogSuppressedAudioForActiveResponse = false;
      didLogInternalModelResolutionAudioSuppressed = false;

      const createdResponseSource = clean(responseState.activeResponseSource || "");

      if (
        createdResponseSource ===
        "tool_followup:submit_booking_step:provider_not_configured"
      ) {
        realtimeState = {
          ...realtimeState,
          bookingTurnStatus: "idle",
          pendingBookingStepKey: "",
          pendingBookingStepPrompt: "",
          pendingBookingStepSlot: "",
          pendingBookingStepExpectedType: "",
          pendingBookingStepValidationConfig: null,
          pendingBookingStepPromptAnchorSeq: undefined,
        } as CallState;

        bookingFlowLoaded = false;
      }

      const pendingBookingStepKey = clean(
        (realtimeState as any).pendingBookingStepKey
      );

      const isBookingToolFollowupResponse =
        isExactBookingPromptResponseSource(createdResponseSource) &&
        Boolean(pendingBookingStepKey);

      if (isBookingToolFollowupResponse) {
        realtimeState = {
          ...realtimeState,
          bookingTurnStatus: "waiting_assistant_prompt",
        } as CallState;
      }

      console.log("[VOICE_REALTIME][RESPONSE_CREATED]", {
        callSid,
        responseId: responseState.activeResponseId,
        source: createdResponseSource,
        pendingBookingStepKey,
        bookingTurnStatus: (realtimeState as any).bookingTurnStatus || "",
        lastUserTranscriptSeq,
      });

      if (endCallGoodbyeRequested && !endCallGoodbyeResponseId) {
        endCallGoodbyeResponseId = responseState.activeResponseId;

        console.log("[VOICE_REALTIME][END_CALL_GOODBYE_RESPONSE_CREATED]", {
          callSid,
          responseId: endCallGoodbyeResponseId,
        });
      }

      return;
    }

    if (event.type === "error") {
      if (isConversationAlreadyHasActiveResponseError(event)) {
        responseController.handleConversationAlreadyHasActiveResponseError();
        return;
      }

      if (isResponseCancelNotActiveError(event)) {
        responseController.handleResponseCancelNotActiveError();
        return;
      }

      console.error("[VOICE_REALTIME][OPENAI_ERROR]", JSON.stringify(event));
      return;
    }

    if (event.type === "response.function_call_arguments.done") {
      const responseState = responseController.getState();
      const activeResponseSource = clean(responseState.activeResponseSource || "");

      const isInternalBookingModelResolution =
        activeResponseSource.startsWith("booking_step_") &&
        activeResponseSource.endsWith("_model_resolution");

      const isIsolatedPostBookingResponse =
        activeResponseSource === "bridge:user_transcript:post_booking";

      toolCallQueue.enqueueRealtimeToolCall({
        ...event,
        sendToolOutputToOpenAi:
          !isInternalBookingModelResolution &&
          !isIsolatedPostBookingResponse,
      });

      return;
    }

    const assistantTranscriptDelta =
      resolveOpenAiRealtimeAssistantTranscriptDelta(event);

    if (assistantTranscriptDelta) {
      if (suppressActiveAssistantAudio) {
        return;
      }

      currentAssistantTranscript += assistantTranscriptDelta;

      const responseState = responseController.getState();
      const activeResponseSource = clean(responseState.activeResponseSource || "");

      const fallbackExpectedPrompt = clean(
        (realtimeState as any).pendingBookingStepPrompt || ""
      );

      const expectedPrompt =
        expectedAssistantPromptForActiveResponse || fallbackExpectedPrompt;

      const shouldEnforceExactPrompt =
        isExactBookingPromptResponseSource(activeResponseSource) &&
        Boolean(expectedPrompt);

      const compatible = isAssistantTranscriptCompatibleWithExpectedPrompt({
        transcript: currentAssistantTranscript,
        expectedPrompt,
      });

      if (
        shouldEnforceExactPrompt &&
        !compatible
      ) {
        if (exactPromptViolationHandledForActiveResponse) {
          return;
        }

        exactPromptViolationHandledForActiveResponse = true;
        suppressActiveAssistantAudio = true;
        pendingExactPromptRetry = true;
        cancelledExactPromptResponseId = responseState.activeResponseId;

        console.error("[VOICE_REALTIME][EXACT_BOOKING_PROMPT_VIOLATION_CANCELLED]", {
          callSid,
          activeResponseId: responseState.activeResponseId,
          activeResponseSource,
          expectedPrompt,
          currentAssistantTranscript,
          pendingBookingStepKey: clean((realtimeState as any).pendingBookingStepKey),
          bookingTurnStatus: clean((realtimeState as any).bookingTurnStatus),
        });

        if (openAiSocket.readyState === WebSocket.OPEN) {
          sendJson(openAiSocket, {
            type: "response.cancel",
          });
        }

        if (streamSid && twilioSocket.readyState === WebSocket.OPEN) {
          sendJson(twilioSocket, {
            event: "clear",
            streamSid,
          });
        }

        return;
      }

      return;
    }

    const audioDelta = resolveOpenAiRealtimeAudioDelta(event);

    if (audioDelta && streamSid) {
      if (suppressActiveAssistantAudio) {
        if (!didLogSuppressedAudioForActiveResponse) {
          didLogSuppressedAudioForActiveResponse = true;

          console.warn("[VOICE_REALTIME][ASSISTANT_AUDIO_SUPPRESSED_AFTER_PROMPT_VIOLATION]", {
            callSid,
            streamSid,
            activeResponseId: responseController.getState().activeResponseId,
            activeResponseSource: responseController.getState().activeResponseSource,
            currentAssistantTranscript,
            expectedAssistantPromptForActiveResponse,
          });
        }

        return;
      }

      if (callEnding) {
        return;
      }

      const responseState = responseController.getState();
      const activeResponseSource = clean(responseState.activeResponseSource || "");

      if (isInternalModelResolutionSource(activeResponseSource)) {
        if (!didLogInternalModelResolutionAudioSuppressed) {
          didLogInternalModelResolutionAudioSuppressed = true;

          console.warn("[VOICE_REALTIME][INTERNAL_MODEL_RESOLUTION_AUDIO_SUPPRESSED]", {
            callSid,
            streamSid,
            activeResponseId: responseState.activeResponseId,
            activeResponseSource,
            pendingBookingStepKey: clean(
              (realtimeState as any).pendingBookingStepKey
            ),
            bookingTurnStatus: clean((realtimeState as any).bookingTurnStatus),
            lastUserTranscriptSeq,
          });
        }

        return;
      }

      const wasAssistantSpeaking = assistantSpeaking;

      assistantSpeaking = true;
      lastAssistantAudioDeltaAtMs = Date.now();

      if (!wasAssistantSpeaking) {
        console.log("[VOICE_REALTIME][ASSISTANT_AUDIO_STARTED]", {
          callSid,
          streamSid,
          activeResponseId: responseState.activeResponseId,
          activeResponseSource,
          pendingBookingStepKey: clean(
            (realtimeState as any).pendingBookingStepKey
          ),
          bookingTurnStatus: clean((realtimeState as any).bookingTurnStatus),
          lastUserTranscriptSeq,
        });
      }

      sendTwilioAudio({
        twilioSocket,
        streamSid,
        payload: audioDelta,
      });

      return;
    }

    if (isOpenAiRealtimeAssistantTranscriptDone(event)) {
      const doneTranscript = resolveOpenAiRealtimeAssistantTranscriptDone(event);

      lastAssistantTranscript = clean(doneTranscript || currentAssistantTranscript);
      currentAssistantTranscript = "";

      realtimeState = {
        ...realtimeState,
        lastAssistantTranscript,
      } as CallState;

      const activeResponseId =
        responseController.getState().activeResponseId || Date.now();

      void saveAndEmitMessage({
        tenantId: tenantId || "",
        messageId: `voice:${callSid || "unknown"}:assistant:${activeResponseId}`,
        content: lastAssistantTranscript,
        role: "assistant",
        canal: "voice",
        fromNumber: callerPhone,
      });

      console.log("[VOICE_REALTIME][ASSISTANT_TRANSCRIPT_DONE]", {
        callSid,
        activeResponseId: responseController.getState().activeResponseId,
        activeResponseSource: responseController.getState().activeResponseSource,
        pendingBookingStepKey: clean((realtimeState as any).pendingBookingStepKey),
        bookingTurnStatus: clean((realtimeState as any).bookingTurnStatus),
        transcript: lastAssistantTranscript,
      });

      return;
    }

    if (event.type === "conversation.item.input_audio_transcription.completed") {
      const assistantAudioActive =
        lastAssistantAudioDeltaAtMs > 0 &&
        Date.now() - lastAssistantAudioDeltaAtMs < 1500;

      const didInterruptForTranscript =
        assistantAudioActive || assistantSpeaking
          ? bargeInController.interruptAssistantAudio(
              "conversation.item.input_audio_transcription.completed"
            )
          : false;

      const isBargeInTranscript =
        didInterruptForTranscript ||
        bargeInController.wasRecentlyInterrupted(2500);

      handleRealtimeUserTranscript({
        event,
        callSid,
        didNumber,
        model,
        currentLocale,
        realtimeState,
        realtimeTenant,
        realtimeCfg,
        localeLocked,
        lastUserTranscriptSeq,
        refreshRealtimeVoiceContext,
        refreshRealtimeSession,
        openAiSocket,
        tenantId,
        callEnding,
        assistantSpeaking: assistantAudioActive,
        lastAssistantAudioDoneAtMs,
        lastAssistantTranscript,
        minMsAfterAssistantAudio: isBargeInTranscript ? 0 : 800,
      })
        .then((transcriptResult) => {
          if (!transcriptResult.consumed) {
            return;
          }

          lastUserTranscript = transcriptResult.lastUserTranscript;
          lastUserTranscriptSeq = transcriptResult.lastUserTranscriptSeq;
          currentLocale = transcriptResult.currentLocale;

          void saveAndEmitMessage({
            tenantId: transcriptResult.tenantId,
            messageId: `voice:${callSid || "unknown"}:user:${transcriptResult.lastUserTranscriptSeq}`,
            content:
              transcriptResult.dashboardUserContent ||
              transcriptResult.lastUserTranscript,
            role: "user",
            canal: "voice",
            fromNumber: callerPhone,
          });

          /**
           * Important:
           * Merge against the live bridge state at assignment time.
           * Do not trust the realtimeState snapshot that was passed when the async
           * transcript handler started, because tool calls may have updated booking
           * state while transcription was being processed.
           */
          realtimeState = mergeTranscriptStatePreservingBookingRuntime({
            currentToolState: realtimeState,
            transcriptState: transcriptResult.realtimeState,
            lastUserTranscriptSeq: transcriptResult.lastUserTranscriptSeq,
          });

          realtimeTenant = transcriptResult.realtimeTenant;
          realtimeCfg = transcriptResult.realtimeCfg;
          localeLocked = transcriptResult.localeLocked;
          tenantId = transcriptResult.tenantId;

          bookingCoordinator.nudgeBookingStepProcessingAfterTranscript();

          const hasPendingBookingStepAfterTranscript = Boolean(
            clean((realtimeState as any).pendingBookingStepKey)
          );

          const bookingTurnStatusAfterTranscript = clean(
            (realtimeState as any).bookingTurnStatus
          );

          const isFreeConversationTurn =
            !hasPendingBookingStepAfterTranscript &&
            (
              !bookingTurnStatusAfterTranscript ||
              bookingTurnStatusAfterTranscript === "idle"
            );

          const shouldWakeModelForFreeUserTranscript =
            isFreeConversationTurn &&
            !callEnding &&
            !hangupRequestedByTool;

          if (shouldWakeModelForFreeUserTranscript) {
            console.log("[VOICE_REALTIME][FREE_USER_TRANSCRIPT_MODEL_WAKE_REQUESTED]", {
              callSid,
              lastUserTranscript,
              lastUserTranscriptSeq,
              bookingTurnStatus: bookingTurnStatusAfterTranscript,
              pendingBookingStepKey: clean((realtimeState as any).pendingBookingStepKey),
            });

            const isAwaitingPostBookingClosure =
              (realtimeState as any).awaitingPostBookingClosure === true &&
              !clean((realtimeState as any).pendingBookingStepKey) &&
              (
                !bookingTurnStatusAfterTranscript ||
                bookingTurnStatusAfterTranscript === "idle"
              );

            const postBookingBusinessInfo =
              clean((realtimeTenant as any)?.info_clave) ||
              clean((realtimeCfg as any)?.info_clave);

            requestRealtimeResponse(
              isAwaitingPostBookingClosure
                ? {
                    conversation: "none",
                    tool_choice: "auto",
                    instructions: [
                      "You are handling a post-booking live phone turn.",
                      "Use the caller's active language.",

                      "The booking flow has already completed successfully.",
                      "The appointment has already been confirmed.",
                      "There is no pending booking step.",
                      "There is no reservation still being processed.",

                      "Never say the booking, reservation, appointment, confirmation, or calendar event is still being processed, finished, reviewed, checked, created, or completed.",
                      "Never ask the caller to wait while the booking, reservation, appointment, confirmation, or calendar event is being processed.",

                      "Do not call create_appointment.",
                      "Do not call submit_booking_step unless the caller clearly asks to start a new booking.",

                      postBookingBusinessInfo
                        ? `Configured business information for this tenant:\n${postBookingBusinessInfo}`
                        : "Configured business information for this tenant is not available in this turn.",

                      "Answer business questions using only the configured business information above.",
                      "Do not invent addresses, locations, hours, prices, services, policies, staff, availability, or contact details.",
                      "If the exact answer is not present in the configured business information above, say that you do not have that specific detail available.",

                      "If the caller asks a question, answer it first, then ask whether they need anything else.",
                      "If the caller clearly indicates the conversation is done, call end_call.",
                    ].join("\n"),
                    input: [
                      {
                        type: "message",
                        role: "user",
                        content: [
                          {
                            type: "input_text",
                            text: [
                              "Latest caller message:",
                              lastUserTranscript,
                              "",
                              "Current runtime state:",
                              "booking_completed=true",
                              "appointment_confirmed=true",
                              "booking_turn_status=idle",
                              "pending_booking_step_key=",
                            ].join("\n"),
                          },
                        ],
                      },
                    ],
                  }
                : {
                  tool_choice: "auto",
                  instructions: [
                    "You are handling a live phone call for the configured tenant business.",

                    `Business name: ${
                      clean((realtimeTenant as any)?.name) ||
                      clean((realtimeTenant as any)?.brand) ||
                      clean((realtimeCfg as any)?.business_name) ||
                      clean((realtimeCfg as any)?.brand) ||
                      "the business"
                    }.`,

                    clean((realtimeTenant as any)?.info_clave) ||
                    clean((realtimeCfg as any)?.info_clave)
                      ? `Configured business information for this tenant:\n${
                          clean((realtimeTenant as any)?.info_clave) ||
                          clean((realtimeCfg as any)?.info_clave)
                        }`
                      : "Configured business information for this tenant is not available in this turn.",

                    "The caller is already speaking with this business.",
                    "Always answer as the assistant for this business.",
                    "Never answer as a generic assistant.",
                    "Never ask what business, salon, barbershop, or company the caller is referring to.",

                    "If the caller wants to book, schedule, reserve, make an appointment, or start any appointment flow in any language, call get_booking_flow.",
                    "Do not ask for service, date, time, name, phone, address, staff, or confirmation directly unless the booking flow has already created a pending booking step.",
                    "For booking intent, use the booking tools instead of continuing as free conversation.",

                    "For non-booking questions, answer using only the configured business information above and available tools.",
                    "Do not invent addresses, locations, hours, prices, services, policies, staff, availability, or contact details.",
                    "If the exact answer is not available, say you do not have that specific detail available right now.",

                    "Respond briefly and naturally in the caller's language.",
                  ].join("\n"),
                  input: [
                    {
                      type: "message",
                      role: "user",
                      content: [
                        {
                          type: "input_text",
                          text: [
                            "Latest caller message:",
                            lastUserTranscript,
                          ].join("\n"),
                        },
                      ],
                    },
                  ],
                },
              isAwaitingPostBookingClosure
                ? "bridge:user_transcript:post_booking"
                : "bridge:user_transcript"
            );
          }
        })
        .catch((error) => {
          console.error("[VOICE_REALTIME][TRANSCRIPT_HANDLER_FATAL_ERROR]", {
            callSid,
            error: error instanceof Error ? error.message : String(error),
          });
        });

      return;
    }

    if (event.type === "response.done") {
      assistantSpeaking = false;
      lastAssistantAudioDoneAtMs = Date.now();

      const retryExactPrompt =
        clean(expectedAssistantPromptForActiveResponse) ||
        clean((realtimeState as any).pendingBookingStepPrompt || "");

      const shouldRetryExactPrompt =
        pendingExactPromptRetry &&
        Boolean(retryExactPrompt) &&
        Boolean(clean((realtimeState as any).pendingBookingStepKey));

      suppressActiveAssistantAudio = false;

      if (!lastAssistantTranscript && currentAssistantTranscript) {
        lastAssistantTranscript = clean(currentAssistantTranscript);
        currentAssistantTranscript = "";

        console.log("[VOICE_REALTIME][ASSISTANT_TRANSCRIPT_FINALIZED_ON_RESPONSE_DONE]", {
          callSid,
          transcript: lastAssistantTranscript,
        });
      }

      const responseStateBeforeDone = responseController.getState();

      const completedResponseSource = responseStateBeforeDone.activeResponseSource;

      const isHumanTransferAnnouncementResponse =
        completedResponseSource ===
        "tool_followup:transfer_to_human:announcement";

      const isCancelledExactPromptResponse =
        Boolean(cancelledExactPromptResponseId) &&
        responseStateBeforeDone.activeResponseId === cancelledExactPromptResponseId;

      console.log("[VOICE_REALTIME][RESPONSE_DONE]", {
        callSid,
        responseId: responseStateBeforeDone.activeResponseId,
        completedResponseSource,
        lastAssistantTranscript,
        lastAssistantAudioDeltaAtMs,
        lastAssistantAudioDoneAtMs,
        msSinceLastAssistantAudio:
          lastAssistantAudioDeltaAtMs > 0 ? Date.now() - lastAssistantAudioDeltaAtMs : null,
        pendingResponseSource: responseStateBeforeDone.pendingResponseSource,
        pendingBookingStepKey: clean((realtimeState as any).pendingBookingStepKey),
        bookingTurnStatus: clean((realtimeState as any).bookingTurnStatus),
        lastUserTranscriptSeq,
      });

      if (
        isHumanTransferAnnouncementResponse &&
        (realtimeState as any).pendingHumanTransfer === true
      ) {
        responseController.markResponseDone({
          lastUserTranscriptSeq,
        });

        humanTransferController.scheduleAfterAnnouncement(
          "transfer_announcement_response_done"
        );

        return;
      }

      if (isCancelledExactPromptResponse) {
        responseController.markResponseDone({
          lastUserTranscriptSeq,
        });

        realtimeState = attachLatestUserTranscriptSeq({
          realtimeState: {
            ...realtimeState,
            bookingTurnStatus: "waiting_assistant_prompt",
          } as CallState,
          lastUserTranscriptSeq,
        });

        console.warn("[VOICE_REALTIME][CANCELLED_EXACT_PROMPT_RESPONSE_NOT_OPENING_TURN]", {
          callSid,
          responseId: responseStateBeforeDone.activeResponseId,
          completedResponseSource,
          retryExactPrompt,
          pendingBookingStepKey: clean((realtimeState as any).pendingBookingStepKey),
          bookingTurnStatus: clean((realtimeState as any).bookingTurnStatus),
        });

        if (shouldRetryExactPrompt && retryExactPrompt) {
          requestRealtimeResponse(
            {
              conversation: "none",
              tool_choice: "none",
              metadata: {
                purpose: "exact_booking_prompt_retry",
                expected_prompt: retryExactPrompt,
              },
              instructions: [
                "You are a speech renderer for a live phone booking flow.",
                "Speak exactly the booking prompt provided in the input.",
                "Do not use conversation history.",
                "Do not reason.",
                "Do not mention availability.",
                "Do not add any other words.",
              ].join("\n"),
              input: [
                {
                  type: "message",
                  role: "user",
                  content: [
                    {
                      type: "input_text",
                      text: [
                        "Speak exactly this booking prompt and nothing else:",
                        "",
                        retryExactPrompt,
                      ].join("\n"),
                    },
                  ],
                },
              ],
            },
            "tool_followup:submit_booking_step:exact_retry"
          );
        }

        expectedAssistantPromptForActiveResponse = retryExactPrompt;
        pendingExactPromptRetry = false;
        exactPromptViolationHandledForActiveResponse = false;
        cancelledExactPromptResponseId = null;
        didLogSuppressedAudioForActiveResponse = false;
        lastAssistantTranscript = "";
        currentAssistantTranscript = "";

        return;
      }

      const pendingBookingStepKey = clean(
        (realtimeState as any).pendingBookingStepKey
      );

      const bookingTurnStatus = clean(
        (realtimeState as any).bookingTurnStatus
      );

      const hasPendingBookingStep = Boolean(pendingBookingStepKey);

      /**
       * Only deterministic booking prompts should open a booking turn.
       * Operational follow-ups, such as provider errors, must not be treated
       * as questions that expect another booking-step answer.
       */
      const isBookingAssistantPromptResponse =
        isExactBookingPromptResponseSource(completedResponseSource) &&
        hasPendingBookingStep;

      if (
        isBookingAssistantPromptResponse &&
        bookingTurnStatus !== "waiting_assistant_prompt" &&
        bookingTurnStatus !== "waiting_user_answer"
      ) {
        realtimeState = {
          ...realtimeState,
          bookingTurnStatus: "waiting_assistant_prompt",
        } as CallState;

        console.log("[VOICE_REALTIME][BOOKING_PROMPT_STATUS_NORMALIZED_ON_RESPONSE_DONE]", {
          callSid,
          completedResponseSource,
          pendingBookingStepKey,
          previousBookingTurnStatus: bookingTurnStatus,
          nextBookingTurnStatus: "waiting_assistant_prompt",
        });
      }

      const responseDoneAnchorSeq = isBookingAssistantPromptResponse
        ? responseStateBeforeDone.activeResponseStartedAtUserTranscriptSeq
        : lastUserTranscriptSeq;

      const responseDoneResult = handleRealtimeResponseDone({
        event,
        callSid,
        realtimeState,
        lastUserTranscript,
        lastUserTranscriptSeq: responseDoneAnchorSeq,
        activeResponseId: responseStateBeforeDone.activeResponseId,
        completedResponseSource,
        pendingResponseCreate: responseStateBeforeDone.pendingResponseCreate,
        hangupRequestedByTool,
        endCallGoodbyeRequested,
        endCallGoodbyeResponseId,
        callEnding,
        onEndCallGoodbyeCompleted: () => {
          scheduleTwilioHangupAfterGoodbye("response_done_callback");
        },
        bookingTurnOpenPlaybackGraceMs: 900,
        scheduleBookingTurnOpenAfterPlaybackGrace: ({
          realtimeState: delayedRealtimeState,
          logPayload,
          graceMs,
        }) => {
          const delayedPendingStepKey = clean(
            (delayedRealtimeState as any).pendingBookingStepKey
          );

          setTimeout(() => {
            if (callEnding || hangupRequestedByTool) {
              return;
            }

            const currentPendingStepKey = clean(
              (realtimeState as any).pendingBookingStepKey
            );

            const currentBookingTurnStatus = clean(
              (realtimeState as any).bookingTurnStatus
            );

            if (
              !delayedPendingStepKey ||
              currentPendingStepKey !== delayedPendingStepKey ||
              currentBookingTurnStatus !== "waiting_assistant_prompt"
            ) {
              console.log("[VOICE_REALTIME][BOOKING_TURN_OPEN_AFTER_GRACE_SKIPPED]", {
                callSid,
                delayedPendingStepKey,
                currentPendingStepKey,
                currentBookingTurnStatus,
                graceMs,
              });

              return;
            }

            realtimeState = delayedRealtimeState;

            console.log("[VOICE_REALTIME][BOOKING_TURN_OPENED_AFTER_PLAYBACK_GRACE]", {
              ...logPayload,
              graceMs,
            });
          }, graceMs);
        },
      });

      realtimeState = attachLatestUserTranscriptSeq({
        realtimeState: responseDoneResult.realtimeState,
        lastUserTranscriptSeq,
      });

      responseController.markResponseDone({
        lastUserTranscriptSeq,
      });

      /**
       * Important:
       * If the caller answered while the assistant prompt was still being completed,
       * the booking turn may open after the transcript was already accepted.
       * This catch-up prevents the user from having to repeat the same answer.
       */
      if (
        !isCancelledExactPromptResponse &&
        isBookingAssistantPromptResponse
      ) {
        bookingCoordinator.catchUpBookingStepIfCallerAnsweredBeforeTurnOpened();
      }

      const flushedPendingResponse =
        responseController.flushPendingRealtimeResponse();

      if (flushedPendingResponse) {
        console.log("[VOICE_REALTIME][PENDING_RESPONSE_FLUSHED_AFTER_RESPONSE_DONE]", {
          callSid,
          completedResponseSource,
          pendingResponseSource: responseStateBeforeDone.pendingResponseSource,
        });
      }

      if (!shouldRetryExactPrompt) {
        expectedAssistantPromptForActiveResponse = "";
        pendingExactPromptRetry = false;
        exactPromptViolationHandledForActiveResponse = false;
        cancelledExactPromptResponseId = null;
        didLogSuppressedAudioForActiveResponse = false;
      }

      if (shouldRetryExactPrompt) {
        console.warn("[VOICE_REALTIME][EXACT_BOOKING_PROMPT_RETRY_REQUESTED]", {
          callSid,
          retryExactPrompt,
          pendingBookingStepKey: clean((realtimeState as any).pendingBookingStepKey),
          bookingTurnStatus: clean((realtimeState as any).bookingTurnStatus),
        });

        requestRealtimeResponse(
          {
            conversation: "none",
            tool_choice: "none",
            metadata: {
              purpose: "exact_booking_prompt_retry",
              expected_prompt: retryExactPrompt,
            },
            instructions: [
              "You are a speech renderer for a live phone booking flow.",
              "Speak exactly the booking prompt provided in the input.",
              "Do not use conversation history.",
              "Do not reason.",
              "Do not mention availability.",
              "Do not add any other words.",
            ].join("\n"),
            input: [
              {
                type: "message",
                role: "user",
                content: [
                  {
                    type: "input_text",
                    text: [
                      "Speak exactly this booking prompt and nothing else:",
                      "",
                      retryExactPrompt,
                    ].join("\n"),
                  },
                ],
              },
            ],
          },
          "tool_followup:submit_booking_step:exact_retry"
        );

        expectedAssistantPromptForActiveResponse = "";
        pendingExactPromptRetry = false;
        exactPromptViolationHandledForActiveResponse = false;
        cancelledExactPromptResponseId = null;
        didLogSuppressedAudioForActiveResponse = false;
      }

      return;
    }
  });

  openAiSocket.on("close", (code, reason) => {
    console.log("[VOICE_REALTIME][OPENAI_CLOSED]", {
      callSid,
      code,
      reason: reason.toString(),
    });

    if (twilioSocket.readyState === WebSocket.OPEN) {
      twilioSocket.close();
    }
  });

  openAiSocket.on("error", (error) => {
    console.error("[VOICE_REALTIME][OPENAI_SOCKET_ERROR]", error);

    if (twilioSocket.readyState === WebSocket.OPEN) {
      twilioSocket.close();
    }
  });

  twilioSocket.on("message", (raw) => {
    const event = safeJsonParseRealtimeEvent(raw) as TwilioUnknownPayload | null;

    if (!event) return;

    if ((event as any).event === "mark") {
      const markName = clean(
        (event as any)?.mark?.name || ""
      );

      if (
        goodbyePlaybackMarkName &&
        markName === goodbyePlaybackMarkName
      ) {
        goodbyePlaybackMarkName = null;

        performTwilioHangup(
          "twilio_goodbye_mark_received"
        );

        return;
      }

      if (
        humanTransferController.handleTwilioMark(
          markName
        )
      ) {
        return;
      }

      return;
    }

    if (isTwilioStartEvent(event)) {
      streamSid = event.start.streamSid;
      callSid = event.start.callSid || null;
      didNumber = event.start.customParameters?.didNumber || null;
      callerPhone = event.start.customParameters?.callerPhone || null;

      bookingFlowLoaded = false;

      hangupRequestedByTool = false;
      callEnding = false;
      goodbyePlaybackMarkName = null;

      if (goodbyeHangupFallbackTimer) {
        clearTimeout(goodbyeHangupFallbackTimer);
        goodbyeHangupFallbackTimer = null;
      }

      twilioAccountSid = clean((event as any)?.start?.accountSid || "") || null;
      localeLocked = false;

      realtimeState = {};
      realtimeTenant = null;
      realtimeCfg = null;
      lastUserTranscript = "";
      lastUserDigits = "";
      lastUserTranscriptSeq = 0;
      bookingCoordinator.reset();
      humanTransferController.reset();
      
      assistantSpeaking = false;
      lastAssistantAudioDeltaAtMs = 0;
      lastAssistantAudioDoneAtMs = 0;
      currentAssistantTranscript = "";
      lastAssistantTranscript = "";
      suppressActiveAssistantAudio = false;
      expectedAssistantPromptForActiveResponse = "";
      exactPromptViolationHandledForActiveResponse = false;
      pendingExactPromptRetry = false;
      didLogSuppressedAudioForActiveResponse = false;
      cancelledExactPromptResponseId = null;
      didLogInternalModelResolutionAudioSuppressed = false;
      bargeInController.reset();

      configureRealtimeSessionIfReady().catch((error) => {
        console.error("[VOICE_REALTIME][SESSION_CONFIG_ERROR]", error);
        twilioSocket.close();
      });

      return;
    }

    if (event.event === "dtmf") {
      const digit = clean((event as any)?.dtmf?.digit || "");
      if (digit) {
        lastUserDigits = digit;
      }
      return;
    }

    if (isTwilioMediaEvent(event)) {
      if (!openAiReady || openAiSocket.readyState !== WebSocket.OPEN) return;

      sendJson(openAiSocket, {
        type: "input_audio_buffer.append",
        audio: event.media.payload,
      });

      return;
    }

    if (isTwilioStopEvent(event)) {
      console.log("[VOICE_REALTIME][TWILIO_STOP]", {
        callSid,
        streamSid,
      });

      void recordVoiceCallEnded({
        tenantId,
        callSid,
        source: "twilio_stop",
      });

      if (openAiSocket.readyState === WebSocket.OPEN) {
        openAiSocket.close();
      }

      return;
    }
  });

  twilioSocket.on("close", (code, reason) => {
    console.log("[VOICE_REALTIME][TWILIO_CLOSED]", {
      callSid,
      streamSid,
      code,
      reason: reason?.toString?.() || "",
      openAiReady,
      sessionConfigured,
      callEnding,
      hangupRequestedByTool,
    });

    void recordVoiceCallEnded({
      tenantId,
      callSid,
      source: "twilio_socket_close",
    });

    if (openAiSocket.readyState === WebSocket.OPEN) {
      openAiSocket.close();
    }
  });

  twilioSocket.on("error", (error) => {
    console.error("[VOICE_REALTIME][TWILIO_SOCKET_ERROR]", {
      callSid,
      streamSid,
      error: error instanceof Error ? error.message : String(error),
    });

    if (openAiSocket.readyState === WebSocket.OPEN) {
      openAiSocket.close();
    }
  });
}