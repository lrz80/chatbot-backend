// src/lib/voice/realtime/openaiRealtimeBridge.ts

import WebSocket from "ws";
import type { CallState } from "../types";

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
  type VoiceLocale,
} from "./realtimeSessionManager";
import { createBookingRealtimeCoordinator } from "./bookingRealtimeCoordinator";
import {
  getOpenAiRealtimeUrl,
  isConversationAlreadyHasActiveResponseError,
  isResponseCancelNotActiveError,
  resolveOpenAiRealtimeAudioDelta,
  safeJsonParseRealtimeEvent,
} from "./openAiRealtimeEvents";
import { createRealtimeToolCallQueue } from "./realtimeToolCallQueue";
import { createUserTranscriptFollowupController } from "./userTranscriptFollowupController";
import { createRealtimeBargeInController } from "./realtimeBargeInController";

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
  let lastAssistantTranscript = "";

  let hangupRequestedByTool = false;
  let endCallGoodbyeRequested = false;
  let endCallGoodbyeResponseId: string | null = null;

  let goodbyePlaybackMarkName: string | null = null;
  let goodbyeHangupFallbackTimer: NodeJS.Timeout | null = null;

  let callEnding = false;

  let localeLocked = false;
  let twilioAccountSid: string | null = null;

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
  });

  const toolCallQueue = createRealtimeToolCallQueue({
    openAiSocket,
    requestRealtimeResponse,

    getCallSid: () => callSid,
    getTenantId: () => tenantId,
    getCallerPhone: () => callerPhone,
    getDidNumber: () => didNumber,
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

  const bookingCoordinator = createBookingRealtimeCoordinator({
    getCallSid: () => callSid,
    getRealtimeState: () => realtimeState,
    getLastUserTranscript: () => lastUserTranscript,
    getLastUserTranscriptSeq: () => lastUserTranscriptSeq,
    enqueueRealtimeToolCall: toolCallQueue.enqueueRealtimeToolCall,
    enqueueSubmitBookingStepFromTranscript:
      toolCallQueue.enqueueSubmitBookingStepFromTranscript,
    requestRealtimeResponse,
  });

  const userTranscriptFollowupController =
    createUserTranscriptFollowupController({
      getCallSid: () => callSid,
      getRealtimeState: () => realtimeState,
      getLastUserTranscript: () => lastUserTranscript,
      getLastUserTranscriptSeq: () => lastUserTranscriptSeq,
      getBookingFlowLoaded: () => bookingFlowLoaded,
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
    source = "unknown"
  ): void {
    const event: Record<string, unknown> = {
      type: "response.create",
      ...(response ? { response } : {}),
    };

    const responseInstructions =
      typeof response?.instructions === "string" ? response.instructions : "";

    const isEndCallFollowup = source === "tool_followup:end_call";

    const shouldCreateEndCallGoodbye =
      isEndCallFollowup &&
      responseInstructions.includes("Say a short, natural goodbye") &&
      !responseInstructions.includes("Do not end the call yet");

    const normalizedSource = clean(source);

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
        source,
      });
    }

    responseController.requestRealtimeResponse({
      event,
      source,
      shouldInterruptActiveResponse,
      startedAtUserTranscriptSeq: lastUserTranscriptSeq,
    });
  }

  async function configureRealtimeSessionIfReady(): Promise<void> {
    if (sessionConfigured) return;
    if (!openAiReady) return;
    if (!callSid) return;
    if (!didNumber) return;
    if (openAiSocket.readyState !== WebSocket.OPEN) return;

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

    currentLocale = "en-US";

    const sessionUpdatePayload = buildRealtimeSessionUpdatePayload({
      businessName: context.brand,
      businessInfo: context.tenant.info_clave || "",
      systemPrompt: context.cfg.system_prompt || "",
      locale: currentLocale,
      model,
    });

    if (openAiSocket.readyState !== WebSocket.OPEN) return;
    if (twilioSocket.readyState !== WebSocket.OPEN) return;

    sendJson(openAiSocket, sessionUpdatePayload);

    if (openAiSocket.readyState !== WebSocket.OPEN) return;
    if (twilioSocket.readyState !== WebSocket.OPEN) return;

    const configuredWelcomeMessage = resolveConfiguredWelcomeMessage({
      cfg: context.cfg || {},
      tenant: context.tenant || {},
    });

    requestRealtimeResponse(
      {
        instructions: buildInitialGreetingFromConfiguredWelcome({
          configuredWelcome: configuredWelcomeMessage,
          brand: context.brand,
          locale: currentLocale,
        }),
      },
      "bridge:initial_greeting"
    );

    tenantId = context.tenantId;
    realtimeTenant = context.tenant;
    realtimeCfg = context.cfg || {};
    realtimeState = {
      ...realtimeState,
      lang: currentLocale,
    };
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

      const createdResponseSource = clean(responseState.activeResponseSource || "");
      const pendingBookingStepKey = clean(
        (realtimeState as any).pendingBookingStepKey
      );

      const isBookingToolFollowupResponse =
        createdResponseSource.startsWith("tool_followup:") &&
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
      if (bookingCoordinator.deferSubmitBookingStepUntilTranscriptIfNeeded(event)) {
        return;
      }

      toolCallQueue.enqueueRealtimeToolCall(event);
      return;
    }

    const audioDelta = resolveOpenAiRealtimeAudioDelta(event);

    if (audioDelta && streamSid) {
      if (callEnding) {
        return;
      }

      const responseState = responseController.getState();
      const activeResponseSource = clean(responseState.activeResponseSource || "");

      if (isInternalModelResolutionSource(activeResponseSource)) {
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

    if (event.type === "response.audio_transcript.done") {
      lastAssistantTranscript = clean(
        event.transcript || event.response?.output_text || ""
      );

      console.log("[VOICE_REALTIME][ASSISTANT_TRANSCRIPT_DONE]", {
        callSid,
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

          const didFlushDeferredSubmit =
            bookingCoordinator.flushDeferredSubmitBookingStepIfReady(
              "transcript_accepted"
            );

          if (!didFlushDeferredSubmit) {
            bookingCoordinator.nudgeBookingStepProcessingAfterTranscript();
          }

          userTranscriptFollowupController.requestFollowupAfterAcceptedUserTranscript();
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

      const responseStateBeforeDone = responseController.getState();

      const completedResponseSource = responseStateBeforeDone.activeResponseSource;

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

      const pendingBookingStepKey = clean(
        (realtimeState as any).pendingBookingStepKey
      );

      const bookingTurnStatus = clean(
        (realtimeState as any).bookingTurnStatus
      );

      const isToolFollowupResponse =
        typeof completedResponseSource === "string" &&
        completedResponseSource.startsWith("tool_followup:");

      const hasPendingBookingStep = !!pendingBookingStepKey;

      /**
       * A tool follow-up can create or continue a booking prompt.
       *
       * Do not require bookingTurnStatus === "waiting_assistant_prompt" here,
       * because some tools, like create_appointment, can return a next_required_step
       * after completing a side effect. In that case the pending step may already
       * exist, but the runtime status can still be stale.
       */
      const isBookingAssistantPromptResponse =
        isToolFollowupResponse && hasPendingBookingStep;

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
      });

      realtimeState = attachLatestUserTranscriptSeq({
        realtimeState: responseDoneResult.realtimeState,
        lastUserTranscriptSeq,
      });

      const bookingTurnStatusAfterResponseDone = clean(
        (realtimeState as any).bookingTurnStatus
      );

      const pendingBookingStepKeyAfterResponseDone = clean(
        (realtimeState as any).pendingBookingStepKey
      );

      if (
        isBookingAssistantPromptResponse &&
        pendingBookingStepKeyAfterResponseDone &&
        bookingTurnStatusAfterResponseDone === "waiting_assistant_prompt"
      ) {
        realtimeState = {
          ...realtimeState,
          bookingTurnStatus: "waiting_user_answer",
        } as CallState;

        console.log("[VOICE_REALTIME][BOOKING_TURN_OPENED_AFTER_RESPONSE_DONE]", {
          callSid,
          responseId: responseStateBeforeDone.activeResponseId,
          completedResponseSource,
          pendingBookingStepKey: pendingBookingStepKeyAfterResponseDone,
          previousBookingTurnStatus: bookingTurnStatusAfterResponseDone,
          nextBookingTurnStatus: "waiting_user_answer",
          lastUserTranscriptSeq,
        });
      }

      responseController.markResponseDone({
        lastUserTranscriptSeq,
      });

      /**
       * Important:
       * If the caller answered while the assistant prompt was still being completed,
       * the booking turn may open after the transcript was already accepted.
       * This catch-up prevents the user from having to repeat the same answer.
       */
      bookingCoordinator.catchUpBookingStepIfCallerAnsweredBeforeTurnOpened();

      bookingCoordinator.flushDeferredSubmitBookingStepIfReady("response_done");

      const flushedPendingResponse =
        responseController.flushPendingRealtimeResponse();

      if (flushedPendingResponse) {
        console.log("[VOICE_REALTIME][PENDING_RESPONSE_FLUSHED_AFTER_RESPONSE_DONE]", {
          callSid,
          completedResponseSource,
          pendingResponseSource: responseStateBeforeDone.pendingResponseSource,
        });
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
      const markName = clean((event as any)?.mark?.name || "");

      if (
        goodbyePlaybackMarkName &&
        markName === goodbyePlaybackMarkName
      ) {
        goodbyePlaybackMarkName = null;
        performTwilioHangup("twilio_goodbye_mark_received");
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
      userTranscriptFollowupController.reset();

      assistantSpeaking = false;
      lastAssistantAudioDeltaAtMs = 0;
      lastAssistantAudioDoneAtMs = 0;
      lastAssistantTranscript = "";
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