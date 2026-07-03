//src/lib/voice/realtime/realtimeToolCallHandler.ts
import WebSocket from "ws";
import type { CallState, VoiceLocale } from "../types";
import { executeRealtimeTool } from "./realtimeToolExecutor";
import type { RealtimeToolResult } from "./toolTypes";
import { validateSubmitBookingStepFreshness } from "./toolGuards/validateSubmitBookingStepFreshness";
import { guardRealtimeEndCall } from "./toolGuards/guardRealtimeEndCall";
import { guardSendBookingSms } from "./toolGuards/guardSendBookingSms";
import { buildNextRealtimeStateFromToolResult } from "./toolState/buildNextRealtimeStateFromToolResult";
import { buildEffectiveRealtimeToolArgs } from "./toolArgs/buildEffectiveRealtimeToolArgs";
import { guardSubmitBookingStepFlowLoaded } from "./toolGuards/guardSubmitBookingStepFlowLoaded";
import { handleRealtimeToolError } from "./toolErrors/handleRealtimeToolError";
import { guardTenantReady } from "./toolGuards/guardTenantReady";
import { handleBlockedSubmitBookingStep } from "./toolGuards/handleBlockedSubmitBookingStep";
import { applyBookingRuntimeStateAfterToolResult } from "./bookingRuntimeState";
import { guardGetBookingFlowIntent } from "./toolGuards/guardGetBookingFlowIntent";
import { bootstrapSubmitBookingStepAfterFlowLoad } from "./toolGuards/bootstrapSubmitBookingStepAfterFlowLoad";
import { clean } from "./utils/clean";
import { sendRealtimeJson } from "./socket/sendRealtimeJson";
import { applySubmitBookingStepEffectiveArgs } from "./toolArgs/applySubmitBookingStepEffectiveArgs";
import { dropDuplicateSubmitBookingStepEarly } from "./toolGuards/dropDuplicateSubmitBookingStepEarly";
import { guardDirectCreateAppointment } from "./toolGuards/guardDirectCreateAppointment";
import { handleRealtimeServerActionRequired } from "./toolExecution/handleRealtimeServerActionRequired";
import { buildExactRealtimeSpeechResponse } from "./buildExactRealtimeSpeechResponse";
import { buildI18nBookingPromptResponse } from "./i18n/buildI18nBookingPromptResponse";
import {
  getBookingLockedLanguageSample,
  getBookingLockedLocale,
  lockBookingLanguage,
  unlockBookingLanguage,
} from "./bookingTurnState";

type HandleRealtimeToolCallParams = {
  event: any;
  sendToolOutputToOpenAi?: boolean;
  openAiSocket: WebSocket;
  requestRealtimeResponse: (
    response?: Record<string, unknown>,
    source?: string,
    options?: {
      sendToolOutputToOpenAi?: boolean;
      endCallGoodbye?: boolean;
    }
  ) => void;
  callSid: string | null;
  tenantId: string | null;
  callerPhone: string | null;
  didNumber: string | null;
  realtimeTenant: any;
  realtimeCfg: any;
  realtimeState: CallState;
  currentLocale: VoiceLocale;
  bookingFlowLoaded: boolean;
  callEnding: boolean;
  lastUserTranscript: string;
  lastUserDigits: string;
};

type HandleRealtimeToolCallResult = {
  consumed: boolean;
  result?: any;
  realtimeState: CallState;
  bookingFlowLoaded: boolean;
  hangupRequestedByTool: boolean;
  callEnding: boolean;
  resetLastUserDigits: boolean;
};

function buildToollessResponse(
  instructions: string
): Record<string, unknown> {
  return {
    instructions,
    tool_choice: "none",
  };
}

function buildLocaleInstruction(locale: string): string {
  const cleanLocale = clean(locale);

  return cleanLocale
    ? `Respond in the caller's active locale: ${cleanLocale}.`
    : "Respond in the caller's active language.";
}

function buildDeterministicToolFollowupInstructions(params: {
  toolName: string;
  toolResult: RealtimeToolResult;
}): string {
  const result = params.toolResult || {};

  const retryPrompt =
    clean((result as any)?.next_required_step?.retry_prompt || "") ||
    clean((result as any)?.retry_prompt || "");

  if ((result as any)?.ok === false && retryPrompt) {
    return retryPrompt;
  }

  const nextRequiredPrompt = clean(
    (result as any)?.next_required_step?.prompt || ""
  );

  if (nextRequiredPrompt) {
    return nextRequiredPrompt;
  }

  const unavailablePrompt =
    clean((result as any)?.unavailable_prompt || "") ||
    clean((result as any)?.next_required_step?.unavailable_prompt || "");

  if (unavailablePrompt) {
    return unavailablePrompt;
  }

  const configuredMessage =
    clean((result as any)?.response_message || "") ||
    clean((result as any)?.message || "") ||
    clean((result as any)?.instructions || "");

  if (configuredMessage) {
    return configuredMessage;
  }

  return "";
}

function shouldUnlockBookingLanguageAfterTool(params: {
  toolName: string;
  toolResult: RealtimeToolResult;
}): boolean {
  const toolName = clean(params.toolName);
  const result = params.toolResult as any;

  if (!result || result.ok === false) return false;

  const isBookingCompletionTool =
    toolName === "create_appointment" ||
    toolName === "end_call";

  if (isBookingCompletionTool) return true;

  if (toolName !== "submit_booking_step") return false;

  const hasNoNextStep = result.next_required_step === null;
  const hasNoActionRequired = !clean(result.action_required || "");

  return hasNoNextStep && hasNoActionRequired;
}

function getPendingBookingStepValidationConfig(
  realtimeState: CallState
): Record<string, unknown> {
  const state = realtimeState as any;
  const value = state.pendingBookingStepValidationConfig;

  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function isPendingPhoneConfirmOrReplaceStep(
  realtimeState: CallState
): boolean {
  const validationConfig = getPendingBookingStepValidationConfig(realtimeState);

  const pendingStepKey = clean((realtimeState as any).pendingBookingStepKey);
  const pendingSlot = clean((realtimeState as any).pendingBookingStepSlot).toLowerCase();
  const expectedType = clean(
    (realtimeState as any).pendingBookingStepExpectedType
  ).toLowerCase();

  const validationMode = clean(validationConfig.mode).toLowerCase();

  const useInboundCaller =
    validationConfig.use_inbound_caller === true ||
    validationConfig.useInboundCaller === true;

  return (
    pendingStepKey === "phone" &&
    pendingSlot === "customer_phone" &&
    expectedType === "phone" &&
    validationMode === "confirm_or_replace" &&
    useInboundCaller === true
  );
}

export async function handleRealtimeToolCall(
  params: HandleRealtimeToolCallParams
): Promise<HandleRealtimeToolCallResult> {
  const {
    event,
    sendToolOutputToOpenAi = true,
    openAiSocket,
    requestRealtimeResponse,
    callSid,
    tenantId,
    callerPhone,
    didNumber,
    realtimeTenant,
    realtimeCfg,
    realtimeState,
    currentLocale,
    bookingFlowLoaded,
    callEnding,
    lastUserTranscript,
    lastUserDigits,
  } = params;

  if (event?.type !== "response.function_call_arguments.done") {
    return {
      consumed: false,
      realtimeState,
      bookingFlowLoaded,
      hangupRequestedByTool: false,
      callEnding,
      resetLastUserDigits: false,
    };
  }

  const toolName = clean(event.name || "");
  const callId = clean(event.call_id || "");
  const isSyntheticToolCall = event?.synthetic === true;

  let toolArgs: Record<string, any> = {};

  if (callEnding && toolName !== "end_call") {
    const blockedResult: RealtimeToolResult = {
      ok: false,
      error: "CALL_ENDING",
    };

    sendRealtimeJson(openAiSocket, {
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(blockedResult),
      },
    });

    return {
      consumed: true,
      realtimeState,
      bookingFlowLoaded,
      hangupRequestedByTool: false,
      callEnding,
      resetLastUserDigits: false,
    };
  }

  try {
    toolArgs = JSON.parse(String(event.arguments || "{}"));
  } catch {
    toolArgs = {};
  }

  if (toolName === "submit_booking_step") {
    const pendingStepKey = clean((realtimeState as any).pendingBookingStepKey);
    const submittedStepKey = clean(toolArgs.step_key);
    const bookingTurnStatus = clean((realtimeState as any).bookingTurnStatus);

    const shouldBindSubmitToPendingStep =
      Boolean(pendingStepKey) &&
      Boolean(submittedStepKey) &&
      submittedStepKey !== pendingStepKey &&
      (
        bookingTurnStatus === "waiting_user_answer" ||
        bookingTurnStatus === "waiting_assistant_prompt"
      );

    if (shouldBindSubmitToPendingStep) {
      const originalToolArgs = { ...toolArgs };

      if (isPendingPhoneConfirmOrReplaceStep(realtimeState)) {
        const blockedResult: RealtimeToolResult = {
          ok: false,
          error: "STALE_SUBMIT_BOOKING_STEP_TOOL_CALL",
          next_required_step: {
            step_key: pendingStepKey,
            prompt: clean((realtimeState as any).pendingBookingStepPrompt || ""),
            required: (realtimeState as any).pendingBookingStepRequired ?? true,
          },
        };

        console.warn("[VOICE_REALTIME][STALE_SUBMIT_BOOKING_STEP_DROPPED_BEFORE_BIND]", {
          callSid,
          pendingStepKey,
          submittedStepKey,
          bookingTurnStatus,
          originalToolArgs,
          lastUserTranscript,
          lastUserTranscriptSeq:
            typeof realtimeState.lastUserTranscriptSeq === "number"
              ? realtimeState.lastUserTranscriptSeq
              : null,
          pendingBookingStepPromptAnchorSeq:
            typeof realtimeState.pendingBookingStepPromptAnchorSeq === "number"
              ? realtimeState.pendingBookingStepPromptAnchorSeq
              : null,
        });

        sendRealtimeJson(openAiSocket, {
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: callId,
            output: JSON.stringify(blockedResult),
          },
        });

        return {
          consumed: true,
          result: blockedResult,
          realtimeState,
          bookingFlowLoaded,
          hangupRequestedByTool: false,
          callEnding,
          resetLastUserDigits: false,
        };
      }

      const transcriptValue = clean(lastUserTranscript);

      toolArgs = {
        ...toolArgs,

        // Runtime owns the active step.
        step_key: pendingStepKey,

        // If the model submitted the wrong step_key, its value belongs to the wrong step too.
        // Use only the latest human transcript for the active pending step.
        value: transcriptValue,
        model_value: "",
        transcript_value: transcriptValue,
        value_candidates: [
          {
            source: "transcript",
            value: transcriptValue,
          },
        ],

        original_step_key: submittedStepKey,
        original_model_value: clean(toolArgs.value || ""),
        step_key_corrected_by_runtime: true,
      };

      console.warn("[VOICE_REALTIME][SUBMIT_BOOKING_STEP_KEY_BOUND_TO_PENDING_STEP]", {
        callSid,
        pendingStepKey,
        submittedStepKey,
        bookingTurnStatus,
        originalToolArgs,
        correctedToolArgs: toolArgs,
        lastUserTranscript,
        lastUserTranscriptSeq:
          typeof realtimeState.lastUserTranscriptSeq === "number"
            ? realtimeState.lastUserTranscriptSeq
            : null,
      });
    }
  }

  if (toolName === "end_call") {
    const endCallGuard = guardRealtimeEndCall({
      callSid,
      realtimeState,
      lastUserTranscript,
    });

    if (!endCallGuard.ok) {
      const blockedResult: RealtimeToolResult = {
        ok: false,
        error: endCallGuard.error,
        message: endCallGuard.message,
      };

      console.warn(
        `[VOICE_REALTIME][${endCallGuard.logEvent}]`,
        endCallGuard.logPayload
      );

      sendRealtimeJson(openAiSocket, {
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: callId,
          output: JSON.stringify(blockedResult),
        },
      });

      requestRealtimeResponse(
        {
          instructions: endCallGuard.responseInstructions,
        },
        endCallGuard.responseSource
      );

      return {
        consumed: true,
        result: blockedResult,
        realtimeState,
        bookingFlowLoaded,
        hangupRequestedByTool: false,
        callEnding,
        resetLastUserDigits: endCallGuard.resetLastUserDigits,
      };
    }
  }

  console.log("[VOICE_REALTIME][TOOL_CALL]", {
    callSid,
    toolName,
    callId,
    toolArgs,
  });

  if (toolName === "submit_booking_step") {
    console.warn("[VOICE_REALTIME][SUBMIT_BOOKING_STEP_RESPONSE_CANCEL_SKIPPED_BEFORE_TOOL_OUTPUT]", {
      callSid,
      callId,
      submittedStepKey: clean(toolArgs.step_key || ""),
    });
  }

  const directCreateAppointmentGuard = guardDirectCreateAppointment({
    toolName,
    callId,
    callSid,
    openAiSocket,
    realtimeState,
    bookingFlowLoaded,
    callEnding,
    lastUserTranscript,
  });

  if (directCreateAppointmentGuard.handled) {
    return {
      consumed: true,
      result: directCreateAppointmentGuard.result,
      realtimeState: directCreateAppointmentGuard.realtimeState,
      bookingFlowLoaded: directCreateAppointmentGuard.bookingFlowLoaded,
      hangupRequestedByTool:
        directCreateAppointmentGuard.hangupRequestedByTool,
      callEnding: directCreateAppointmentGuard.callEnding,
      resetLastUserDigits: directCreateAppointmentGuard.resetLastUserDigits,
    };
  }

  const tenantReadyGuard = guardTenantReady({
    tenantId,
    callId,
    openAiSocket,
    requestRealtimeResponse,
    realtimeState,
    bookingFlowLoaded,
    callEnding,
  });

  if (tenantReadyGuard.handled) {
    return {
      consumed: true,
      realtimeState: tenantReadyGuard.realtimeState,
      bookingFlowLoaded: tenantReadyGuard.bookingFlowLoaded,
      hangupRequestedByTool: tenantReadyGuard.hangupRequestedByTool,
      callEnding: tenantReadyGuard.callEnding,
      resetLastUserDigits: tenantReadyGuard.resetLastUserDigits,
    };
  }

  if (!tenantId) {
    throw new Error("TENANT_NOT_READY_AFTER_GUARD");
  }

  const resolvedTenantId: string = tenantId;

  const getBookingFlowIntentGuard = guardGetBookingFlowIntent({
    toolName,
    callId,
    callSid,
    openAiSocket,
    requestRealtimeResponse,
    realtimeState,
    bookingFlowLoaded,
    callEnding,
    lastUserTranscript,
    lastUserDigits,
  });

  if (getBookingFlowIntentGuard.handled) {
    return {
      consumed: true,
      result: getBookingFlowIntentGuard.result,
      realtimeState: getBookingFlowIntentGuard.realtimeState,
      bookingFlowLoaded: getBookingFlowIntentGuard.bookingFlowLoaded,
      hangupRequestedByTool: getBookingFlowIntentGuard.hangupRequestedByTool,
      callEnding: getBookingFlowIntentGuard.callEnding,
      resetLastUserDigits: getBookingFlowIntentGuard.resetLastUserDigits,
    };
  }
  
  const unsafeToolRequiresRecentUserInput =
    toolName === "send_useful_link_sms" ||
    toolName === "send_booking_sms" ||
    toolName === "submit_booking_step";

  const hasRecentUserInputAfterBookingPrompt =
    typeof realtimeState.lastUserTranscriptSeq === "number" &&
    typeof realtimeState.pendingBookingStepPromptAnchorSeq === "number" &&
    realtimeState.lastUserTranscriptSeq > realtimeState.pendingBookingStepPromptAnchorSeq;

  const isWaitingForAssistantPrompt =
    (realtimeState as any).bookingTurnStatus === "waiting_assistant_prompt";

  if (
    unsafeToolRequiresRecentUserInput &&
    isWaitingForAssistantPrompt &&
    toolName !== "submit_booking_step"
  ) {
    const blockedResult: RealtimeToolResult = {
      ok: false,
      error: "TOOL_BLOCKED_WHILE_ASSISTANT_PROMPT_NOT_COMPLETED",
    };

    console.warn("[VOICE_REALTIME][TOOL_BLOCKED_WHILE_ASSISTANT_PROMPT_NOT_COMPLETED]", {
      callSid,
      toolName,
      bookingTurnStatus: (realtimeState as any).bookingTurnStatus || "",
      lastUserTranscript,
      lastUserTranscriptSeq:
        typeof realtimeState.lastUserTranscriptSeq === "number"
          ? realtimeState.lastUserTranscriptSeq
          : null,
      pendingBookingStepPromptAnchorSeq:
        typeof realtimeState.pendingBookingStepPromptAnchorSeq === "number"
          ? realtimeState.pendingBookingStepPromptAnchorSeq
          : null,
    });

    sendRealtimeJson(openAiSocket, {
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(blockedResult),
      },
    });

    return {
      consumed: true,
      result: blockedResult,
      realtimeState,
      bookingFlowLoaded,
      hangupRequestedByTool: false,
      callEnding,
      resetLastUserDigits: false,
    };
  }

  const sendBookingSmsGuard = await guardSendBookingSms({
    toolName,
    toolArgs,
    callId,
    openAiSocket,
    callSid,
    tenantId: resolvedTenantId,
    callerPhone,
    didNumber,
    realtimeTenant,
    realtimeCfg,
    realtimeState,
    currentLocale,
    bookingFlowLoaded,
    callEnding,
    lastUserTranscript,
    lastUserDigits,
  });

  if (sendBookingSmsGuard.handled) {
    return {
      consumed: true,
      result: sendBookingSmsGuard.result,
      realtimeState: sendBookingSmsGuard.realtimeState,
      bookingFlowLoaded: sendBookingSmsGuard.bookingFlowLoaded,
      hangupRequestedByTool: sendBookingSmsGuard.hangupRequestedByTool,
      callEnding: sendBookingSmsGuard.callEnding,
      resetLastUserDigits: sendBookingSmsGuard.resetLastUserDigits,
    };
  }

  if (toolName === "submit_booking_step" && !bookingFlowLoaded) {
    const bootstrapResult = await bootstrapSubmitBookingStepAfterFlowLoad({
      toolArgs,
      callId,
      callSid,
      openAiSocket,
      requestRealtimeResponse,
      tenantId: resolvedTenantId,
      callerPhone,
      didNumber,
      tenant: realtimeTenant,
      cfg: realtimeCfg,
      realtimeState,
      currentLocale,
      callEnding,
      lastUserTranscript,
      lastUserDigits,
      isSyntheticToolCall,
    });

    if (bootstrapResult.handled) {
      return {
        consumed: true,
        result: bootstrapResult.result,
        realtimeState: bootstrapResult.realtimeState,
        bookingFlowLoaded: bootstrapResult.bookingFlowLoaded,
        hangupRequestedByTool: bootstrapResult.hangupRequestedByTool,
        callEnding: bootstrapResult.callEnding,
        resetLastUserDigits: bootstrapResult.resetLastUserDigits,
      };
    }
  }

  const bookingFlowLoadedGuard = guardSubmitBookingStepFlowLoaded({
    toolName,
    callId,
    openAiSocket,
    requestRealtimeResponse,
    callSid,
    realtimeState,
    bookingFlowLoaded,
    callEnding,
  });

  if (bookingFlowLoadedGuard.handled) {
    return {
      consumed: true,
      result: bookingFlowLoadedGuard.result,
      realtimeState: bookingFlowLoadedGuard.realtimeState,
      bookingFlowLoaded: bookingFlowLoadedGuard.bookingFlowLoaded,
      hangupRequestedByTool: bookingFlowLoadedGuard.hangupRequestedByTool,
      callEnding: bookingFlowLoadedGuard.callEnding,
      resetLastUserDigits: bookingFlowLoadedGuard.resetLastUserDigits,
    };
  }

  if (toolName === "submit_booking_step") {
    const duplicateSubmitGuard = dropDuplicateSubmitBookingStepEarly({
      toolName,
      toolArgs,
      callId,
      callSid,
      openAiSocket,
      realtimeState,
      bookingFlowLoaded,
      callEnding,
      isSyntheticToolCall,
      lastUserTranscript,
    });

    if (duplicateSubmitGuard.handled) {
      return {
        consumed: true,
        result: duplicateSubmitGuard.result,
        realtimeState: duplicateSubmitGuard.realtimeState,
        bookingFlowLoaded: duplicateSubmitGuard.bookingFlowLoaded,
        hangupRequestedByTool: duplicateSubmitGuard.hangupRequestedByTool,
        callEnding: duplicateSubmitGuard.callEnding,
        resetLastUserDigits: duplicateSubmitGuard.resetLastUserDigits,
      };
    }

    const freshness = validateSubmitBookingStepFreshness({
      toolArgs,
      realtimeState,
      lastUserTranscript,
    });

    const submittedStepKey = clean(toolArgs.step_key);
    const modelValue = clean(toolArgs.value);

    const pendingStepKey = clean((realtimeState as any).pendingBookingStepKey);

    const currentTranscriptSeq =
      typeof realtimeState.lastUserTranscriptSeq === "number"
        ? realtimeState.lastUserTranscriptSeq
        : -1;

    const promptAnchorSeq =
      typeof realtimeState.pendingBookingStepPromptAnchorSeq === "number"
        ? realtimeState.pendingBookingStepPromptAnchorSeq
        : -1;

    const isSubmittingCurrentPendingStep =
      submittedStepKey &&
      pendingStepKey &&
      submittedStepKey === pendingStepKey;

    const hasHumanTranscriptAfterAnchor =
      currentTranscriptSeq > promptAnchorSeq;

    if (!freshness.ok && !freshness.canAcceptModelValueDuringTranscriptRace) {
      return handleBlockedSubmitBookingStep({
        callSid,
        callId,
        openAiSocket,
        freshness,
        realtimeState,
        bookingFlowLoaded,
        callEnding,
      });
    }
  }

  let effectiveToolArgs = buildEffectiveRealtimeToolArgs({
    toolName,
    toolArgs,
    lastUserTranscript,
  });

  if (
    toolName === "submit_booking_step" &&
    !(
      clean(toolArgs.step_key) === "confirm" &&
      ["confirm", "cancel", "unknown"].includes(clean(toolArgs.value).toLowerCase())
    )
  ) {
    effectiveToolArgs = applySubmitBookingStepEffectiveArgs({
      effectiveToolArgs,
      rawToolArgs: toolArgs,
      realtimeState,
      lastUserTranscript,
    });

    if (effectiveToolArgs.should_drop_submit_booking_step === true) {
      const blockedResult: RealtimeToolResult = {
        ok: false,
        error: "STALE_SUBMIT_BOOKING_STEP_TOOL_CALL",
        next_required_step: realtimeState.pendingBookingStepKey
          ? {
              step_key: realtimeState.pendingBookingStepKey,
              prompt: realtimeState.pendingBookingStepPrompt || "",
              required: realtimeState.pendingBookingStepRequired ?? true,
            }
          : null,
      };

      console.warn("[VOICE_REALTIME][SUBMIT_BOOKING_STEP_DROPPED_STALE_TOOL_CALL]", {
        callSid,
        pendingStepKey: effectiveToolArgs.step_key,
        originalStepKey: effectiveToolArgs.original_step_key,
        originalModelValue: effectiveToolArgs.original_model_value,
        transcriptValue: effectiveToolArgs.transcript_value,
        lastUserTranscriptSeq:
          typeof realtimeState.lastUserTranscriptSeq === "number"
            ? realtimeState.lastUserTranscriptSeq
            : null,
      });

      sendRealtimeJson(openAiSocket, {
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: callId,
          output: JSON.stringify(blockedResult),
        },
      });

      return {
        consumed: true,
        result: blockedResult,
        realtimeState,
        bookingFlowLoaded,
        hangupRequestedByTool: false,
        callEnding,
        resetLastUserDigits: false,
      };
    }
  }

  if (toolName === "submit_booking_step") {
    console.log("[VOICE_REALTIME][SUBMIT_STEP_VALUE_SOURCE]", {
      callSid,
      step_key: effectiveToolArgs.step_key,
      model_value: clean(effectiveToolArgs.model_value || ""),
      transcript_value: clean(effectiveToolArgs.transcript_value || ""),
      forwarded_value: clean(effectiveToolArgs.value || ""),
      value_candidates: effectiveToolArgs.value_candidates || [],
      lastUserTranscriptSeq:
        typeof realtimeState.lastUserTranscriptSeq === "number"
          ? realtimeState.lastUserTranscriptSeq
          : null,
    });
  }

  try {
    const toolResult = await executeRealtimeTool({
      tenantId: resolvedTenantId,
      callerPhone,
      toolName,
      args: effectiveToolArgs,
      tenant: realtimeTenant,
      cfg: realtimeCfg,
      callSid: callSid || undefined,
      didNumber: didNumber || undefined,
      currentLocale,
      state: realtimeState,
      userInput: lastUserTranscript,
      digits: lastUserDigits,
    });

    const nextBookingFlowLoaded =
      toolName === "get_booking_flow" && toolResult?.ok ? true : bookingFlowLoaded;

    const baseNextRealtimeState = buildNextRealtimeStateFromToolResult({
      realtimeState,
      toolName,
      toolResult,
      effectiveToolArgs,
      currentLocale,
      lastUserTranscript,
    });

    const nextRealtimeState = applyBookingRuntimeStateAfterToolResult({
      realtimeState: baseNextRealtimeState,
      toolName,
      toolResult,
      effectiveToolArgs,
      lastUserTranscript,
    });

    const realtimeStateWithBookingLanguage =
      toolName === "get_booking_flow" && toolResult?.ok === true
        ? lockBookingLanguage({
            realtimeState: nextRealtimeState,
            currentLocale,
            lastUserTranscript,
          })
        : shouldUnlockBookingLanguageAfterTool({
            toolName,
            toolResult: (toolResult || {}) as RealtimeToolResult,
          })
          ? unlockBookingLanguage(nextRealtimeState)
          : nextRealtimeState;

    const hangupRequestedByTool =
      toolName === "end_call" && toolResult?.ok === true;

    /**
     * Do not mark callEnding here.
     * The bridge still needs to send the goodbye audio generated after end_call.
     * callEnding must become true only after the goodbye response is done
     * and Twilio hangup is actually triggered.
     */
    const nextCallEnding = callEnding;

    console.log("[VOICE_REALTIME][TOOL_RESULT]", {
      callSid,
      toolName,
      ok: toolResult?.ok,
      error: toolResult?.error,
      missing_required_slots: toolResult?.missing_required_slots,
      next_required_step: toolResult?.next_required_step,
    });

    if (toolName === "send_useful_link_sms" && toolResult?.ok === false) {
      console.warn("[VOICE_REALTIME][USEFUL_LINK_SMS_ERROR_FOLLOWUP_REQUESTED]", {
        callSid,
        error: toolResult?.error,
        currentLocale,
      });

      requestRealtimeResponse(
        buildToollessResponse(
          [
            buildLocaleInstruction(currentLocale),
            "Briefly explain that the link could not be sent by text right now.",
            "Do not mention technical errors, configuration, tools, APIs, or backend details.",
            "If the business information is already known from the conversation, repeat the useful information verbally.",
            "Ask only one short question to check whether the caller needs anything else.",
          ].join("\n")
        ),
        "tool_followup:send_useful_link_sms:error"
      );

      return {
        consumed: true,
        result: toolResult as RealtimeToolResult,
        realtimeState: nextRealtimeState,
        bookingFlowLoaded: nextBookingFlowLoaded,
        hangupRequestedByTool,
        callEnding: nextCallEnding,
        resetLastUserDigits: true,
      };
    }

    const shouldSendFunctionCallOutput =
      !isSyntheticToolCall &&
      sendToolOutputToOpenAi !== false &&
      toolName !== "get_booking_flow";

    if (shouldSendFunctionCallOutput) {
      sendRealtimeJson(openAiSocket, {
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: callId,
          output: JSON.stringify(toolResult),
        },
      });
    } else {
      console.log("[VOICE_REALTIME][TOOL_OUTPUT_NOT_SENT_TO_OPENAI]", {
        callSid,
        toolName,
        callId,
        synthetic: isSyntheticToolCall,
        sendToolOutputToOpenAi,
        ok: toolResult?.ok,
        error: toolResult?.error,
        nextRequiredStepKey: clean(toolResult?.next_required_step?.step_key || ""),
        nextRequiredPrompt: clean(toolResult?.next_required_step?.prompt || ""),
      });
    }

    if (toolName === "end_call" && toolResult?.ok === true) {
      console.warn("[VOICE_REALTIME][END_CALL_GOODBYE_FOLLOWUP_REQUESTED]", {
        callSid,
        callId,
        currentLocale,
      });

      requestRealtimeResponse(
        buildToollessResponse(
          [
            buildLocaleInstruction(currentLocale),
            "Say only one short, natural goodbye.",
            "Do not ask another question.",
            "Do not offer more help.",
            "Do not mention tools.",
            "Do not continue the conversation.",
            "Do not confirm anything else.",
          ].join("\n")
        ),
        "tool_followup:end_call",
        {
          sendToolOutputToOpenAi: false,
          endCallGoodbye: true,
        }
      );
    }

    const actionRequired = clean((toolResult as any)?.action_required || "");

    const requestServerActionRealtimeResponse: typeof requestRealtimeResponse = (
      response,
      source
    ) => {
      const isCreateAppointmentFollowup =
        actionRequired === "create_appointment" ||
        source === "tool_followup:create_appointment";

      const instructions = clean(response?.instructions || "");

      requestRealtimeResponse(response, source);
    };

    const serverActionResult = await handleRealtimeServerActionRequired({
      toolName,
      toolResult: (toolResult || {}) as RealtimeToolResult,
      actionRequired,
      resolvedTenantId,
      callerPhone,
      didNumber,
      realtimeTenant,
      realtimeCfg,
      callSid,
      currentLocale,
      realtimeState,
      nextRealtimeState: realtimeStateWithBookingLanguage,
      bookingFlowLoaded,
      nextBookingFlowLoaded,
      callEnding,
      nextCallEnding,
      lastUserTranscript,
      lastUserDigits,
      requestRealtimeResponse: requestServerActionRealtimeResponse,
    });

    if (serverActionResult.handled) {
      return {
        consumed: true,
        result: serverActionResult.result,
        realtimeState: serverActionResult.realtimeState,
        bookingFlowLoaded: serverActionResult.bookingFlowLoaded,
        hangupRequestedByTool: serverActionResult.hangupRequestedByTool,
        callEnding: serverActionResult.callEnding,
        resetLastUserDigits: serverActionResult.resetLastUserDigits,
      };
    }

    const retryPrompt =
      clean((toolResult as any)?.next_required_step?.retry_prompt || "") ||
      clean((toolResult as any)?.next_required_step?.prompt || "");

    const retryStepKey = clean(
      (toolResult as any)?.next_required_step?.step_key || ""
    );

    const shouldForceStepRetryPrompt =
      toolName === "submit_booking_step" &&
      (toolResult as any)?.ok === false &&
      Boolean(retryStepKey) &&
      Boolean(retryPrompt);

    if (shouldForceStepRetryPrompt) {
      console.warn("[VOICE_REALTIME][BOOKING_STEP_RETRY_PROMPT_FORCED]", {
        callSid,
        toolName,
        error: (toolResult as any)?.error,
        retryStepKey,
        retryPrompt,
        source: "tool_followup:submit_booking_step:retry",
      });

      requestRealtimeResponse(
        buildI18nBookingPromptResponse({
          prompt: retryPrompt,
          currentLocale,
          lastAssistantTranscript:
            clean((realtimeState as any).lastAssistantTranscript || ""),
          bookingLanguage: clean(
            (realtimeStateWithBookingLanguage as any).conversationLanguage ||
            (nextRealtimeState as any).conversationLanguage ||
            (realtimeState as any).conversationLanguage ||
            ""
          ),
          bookingLockedLocale: getBookingLockedLocale(realtimeStateWithBookingLanguage),
          bookingLockedLanguageSample:
            getBookingLockedLanguageSample(realtimeStateWithBookingLanguage),
        }),
        "tool_followup:submit_booking_step:retry"
      );

      return {
        consumed: true,
        result: toolResult as RealtimeToolResult,
        realtimeState: realtimeStateWithBookingLanguage,
        bookingFlowLoaded: nextBookingFlowLoaded,
        hangupRequestedByTool,
        callEnding: nextCallEnding,
        resetLastUserDigits: true,
      };
    }

    const nextRequiredPrompt = clean(
      (toolResult as any)?.next_required_step?.prompt || ""
    );

    const nextRequiredStepKey = clean(
      (toolResult as any)?.next_required_step?.step_key || ""
    );

    const shouldForceSubmitBookingStepPrompt =
      toolName === "submit_booking_step" &&
      Boolean(nextRequiredStepKey) &&
      Boolean(nextRequiredPrompt);

    if (shouldForceSubmitBookingStepPrompt) {
      console.warn("[VOICE_REALTIME][SUBMIT_BOOKING_STEP_TOOL_RESULT_PROMPT_FORCED]", {
        callSid,
        toolName,
        ok: (toolResult as any)?.ok,
        nextRequiredStepKey,
        nextRequiredPrompt,
        source: "tool_followup:submit_booking_step",
      });

      requestRealtimeResponse(
        buildI18nBookingPromptResponse({
          prompt: nextRequiredPrompt,
          currentLocale,
          lastAssistantTranscript:
            clean((realtimeState as any).lastAssistantTranscript || ""),
          bookingLanguage: clean(
            (realtimeStateWithBookingLanguage as any).conversationLanguage ||
            (nextRealtimeState as any).conversationLanguage ||
            (realtimeState as any).conversationLanguage ||
            ""
          ),
          bookingLockedLocale: getBookingLockedLocale(realtimeStateWithBookingLanguage),
          bookingLockedLanguageSample:
            getBookingLockedLanguageSample(realtimeStateWithBookingLanguage),
        }),
        "tool_followup:submit_booking_step"
      );

      return {
        consumed: true,
        result: toolResult as RealtimeToolResult,
        realtimeState: realtimeStateWithBookingLanguage,
        bookingFlowLoaded: nextBookingFlowLoaded,
        hangupRequestedByTool,
        callEnding: nextCallEnding,
        resetLastUserDigits: true,
      };
    }

    const deterministicFollowupInstructions =
      buildDeterministicToolFollowupInstructions({
        toolName,
        toolResult: (toolResult || {}) as RealtimeToolResult,
      });

    if (deterministicFollowupInstructions) {
      const shouldSpeakExactBookingPrompt =
        Boolean(nextRequiredPrompt) ||
        (toolName === "submit_booking_step" && Boolean(retryPrompt));

      if (shouldSpeakExactBookingPrompt) {
        requestRealtimeResponse(
          buildI18nBookingPromptResponse({
            prompt: deterministicFollowupInstructions,
            currentLocale,
            lastAssistantTranscript:
              clean((realtimeState as any).lastAssistantTranscript || ""),
            bookingLanguage: clean(
              (realtimeStateWithBookingLanguage as any).conversationLanguage ||
              (nextRealtimeState as any).conversationLanguage ||
              (realtimeState as any).conversationLanguage ||
              ""
            ),
            bookingLockedLocale: getBookingLockedLocale(realtimeStateWithBookingLanguage),
            bookingLockedLanguageSample:
              getBookingLockedLanguageSample(realtimeStateWithBookingLanguage),
          }),
          `tool_followup:${toolName}`
        );
      } else {
        requestRealtimeResponse(
          {
            instructions: deterministicFollowupInstructions,
          },
          `tool_followup:${toolName}`
        );
      }
    }

    return {
      consumed: true,
      result: toolResult as RealtimeToolResult,
      realtimeState: nextRealtimeState,
      bookingFlowLoaded: nextBookingFlowLoaded,
      hangupRequestedByTool,
      callEnding: nextCallEnding,
      resetLastUserDigits: true,
    };
  } catch (error) {
    return handleRealtimeToolError({
      error,
      callSid,
      toolName,
      callId,
      openAiSocket,
      requestRealtimeResponse,
      realtimeState,
      bookingFlowLoaded,
      callEnding,
    });
  }
}