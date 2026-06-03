//src/lib/voice/realtime/realtimeToolCallHandler.ts
import WebSocket from "ws";
import type { CallState } from "../types";
import { executeRealtimeTool } from "./realtimeToolExecutor";
import { type RealtimeToolResult } from "./buildToolFollowupInstructions";
import { validateSubmitBookingStepFreshness } from "./toolGuards/validateSubmitBookingStepFreshness";
import { guardRealtimeEndCall } from "./toolGuards/guardRealtimeEndCall";
import { guardSendBookingSms } from "./toolGuards/guardSendBookingSms";
import { buildNextRealtimeStateFromToolResult } from "./toolState/buildNextRealtimeStateFromToolResult";
import { buildEffectiveRealtimeToolArgs } from "./toolArgs/buildEffectiveRealtimeToolArgs";
import { resolveRealtimeToolFollowupInstructions } from "./toolFollowup/resolveRealtimeToolFollowupInstructions";
import { guardSubmitBookingStepFlowLoaded } from "./toolGuards/guardSubmitBookingStepFlowLoaded";
import { handleRealtimeToolError } from "./toolErrors/handleRealtimeToolError";
import { guardTenantReady } from "./toolGuards/guardTenantReady";
import { handleBlockedSubmitBookingStep } from "./toolGuards/handleBlockedSubmitBookingStep";
import { applyBookingRuntimeStateAfterToolResult } from "./bookingRuntimeState";
import { canSubmitBookingStepNow } from "./bookingTurnState";
import { guardGetBookingFlowIntent } from "./toolGuards/guardGetBookingFlowIntent";
import { bootstrapSubmitBookingStepAfterFlowLoad } from "./toolGuards/bootstrapSubmitBookingStepAfterFlowLoad";
import { isStaleAlreadyHandledSubmitBlockedByTurnState } from "./toolGuards/isStaleAlreadyHandledSubmitBlockedByTurnState";
import { buildSyntheticBookingStepFollowupInstructions } from "./toolFollowup/buildSyntheticBookingStepFollowupInstructions";
import { handleStaleSubmitBookingStepPrompt } from "./toolGuards/handleStaleSubmitBookingStepPrompt";
import { clean } from "./utils/clean";
import { sendRealtimeJson } from "./socket/sendRealtimeJson";
import { applySubmitBookingStepEffectiveArgs } from "./toolArgs/applySubmitBookingStepEffectiveArgs";
import { buildSubmitBookingStepNotReadyInstructions } from "./toolFollowup/buildSubmitBookingStepNotReadyInstructions";
import { resolveSyntheticSubmitBookingStepFollowup } from "./toolFollowup/resolveSyntheticSubmitBookingStepFollowup";

type VoiceLocale = "en-US" | "es-ES" | "pt-BR";

type HandleRealtimeToolCallParams = {
  event: any;
  openAiSocket: WebSocket;
  requestRealtimeResponse: (
    response?: Record<string, unknown>,
    source?: string
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

export async function handleRealtimeToolCall(
  params: HandleRealtimeToolCallParams
): Promise<HandleRealtimeToolCallResult> {
  const {
    event,
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
    requestRealtimeResponse,
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
    const freshness = validateSubmitBookingStepFreshness({
      toolArgs,
      realtimeState,
      lastUserTranscript,
    });

    const turnGate = canSubmitBookingStepNow({
      realtimeState,
      submittedStepKey: clean(toolArgs.step_key),
      lastUserTranscriptSeq:
        typeof realtimeState.lastUserTranscriptSeq === "number"
          ? realtimeState.lastUserTranscriptSeq
          : -1,
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

    const canBypassTurnGateForTranscriptRace =
      !turnGate.ok &&
      turnGate.reason === "NO_NEW_USER_ANSWER" &&
      freshness.canAcceptModelValueDuringTranscriptRace;

    const canBypassTurnGateForEarlyAnswerDuringAssistantPrompt =
      !turnGate.ok &&
      turnGate.reason === "ASSISTANT_PROMPT_NOT_COMPLETED" &&
      isSubmittingCurrentPendingStep &&
      Boolean(modelValue) &&
      hasHumanTranscriptAfterAnchor;

    const currentTranscript = clean(lastUserTranscript);

    const hasNoAcceptedHumanTranscript =
      !currentTranscript ||
      (typeof realtimeState.lastUserTranscriptSeq === "number" &&
        typeof realtimeState.pendingBookingStepPromptAnchorSeq === "number" &&
        realtimeState.lastUserTranscriptSeq <= realtimeState.pendingBookingStepPromptAnchorSeq);

    const isModelOnlySubmitWithoutAcceptedHumanInput =
      submittedStepKey === "service" &&
      Boolean(modelValue) &&
      hasNoAcceptedHumanTranscript &&
      !freshness.hasNewHumanTranscript &&
      !freshness.canAcceptModelValueDuringTranscriptRace;

    if (isModelOnlySubmitWithoutAcceptedHumanInput) {
      const blockedResult: RealtimeToolResult = {
        ok: false,
        error: "BOOKING_STEP_WAITING_FOR_NEW_USER_INPUT",
        message: "Ignored model-only submit without accepted human transcript.",
        next_required_step: realtimeState.pendingBookingStepKey
          ? {
              step_key: realtimeState.pendingBookingStepKey,
              prompt: realtimeState.pendingBookingStepPrompt || "",
              required: realtimeState.pendingBookingStepRequired ?? true,
            }
          : undefined,
      };

      console.warn("[VOICE_REALTIME][BOOKING_SUBMIT_BLOCKED_MODEL_ONLY_WITHOUT_ACCEPTED_TRANSCRIPT]", {
        callSid,
        submittedStepKey,
        modelValue,
        currentTranscript,
        bookingTurnStatus: (realtimeState as any).bookingTurnStatus || "",
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

    if (
      !turnGate.ok &&
      !canBypassTurnGateForTranscriptRace &&
      !canBypassTurnGateForEarlyAnswerDuringAssistantPrompt
    ) {
      const blockedResult: RealtimeToolResult = {
        ok: false,
        error: "BOOKING_STEP_NOT_READY_FOR_SUBMIT",
        message: turnGate.reason,
        next_required_step: realtimeState.pendingBookingStepKey
          ? {
              step_key: realtimeState.pendingBookingStepKey,
              prompt: realtimeState.pendingBookingStepPrompt || "",
              required: realtimeState.pendingBookingStepRequired ?? true,
            }
          : undefined,
      };

      console.warn("[VOICE_REALTIME][BOOKING_SUBMIT_BLOCKED_BY_TURN_STATE]", {
        callSid,
        reason: turnGate.reason,
        submittedStepKey: clean(toolArgs.step_key),
        pendingBookingStepKey: realtimeState.pendingBookingStepKey || "",
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

      /**
       * If the issue is simply that there is no new transcript yet, do not create
       * another assistant response and do not interrupt active audio.
       */
      const shouldSilentlyIgnoreBlockedSubmit =
        turnGate.reason === "NO_NEW_USER_ANSWER" ||
        turnGate.reason === "ASSISTANT_PROMPT_NOT_COMPLETED" ||
        isStaleAlreadyHandledSubmitBlockedByTurnState({
          reason: turnGate.reason,
          submittedStepKey: clean(toolArgs.step_key),
          pendingStepKey: realtimeState.pendingBookingStepKey || "",
          bookingTurnStatus: (realtimeState as any).bookingTurnStatus || "",
          lastUserTranscript,
          lastUserTranscriptSeq:
            typeof realtimeState.lastUserTranscriptSeq === "number"
              ? realtimeState.lastUserTranscriptSeq
              : -1,
          lastSubmittedBookingStepKey:
            realtimeState.lastSubmittedBookingStepKey || "",
          lastSubmittedBookingTranscript:
            realtimeState.lastSubmittedBookingTranscript || "",
          lastSubmittedBookingTranscriptSeq:
            typeof realtimeState.lastSubmittedBookingTranscriptSeq === "number"
              ? realtimeState.lastSubmittedBookingTranscriptSeq
              : -1,
        });

      if (shouldSilentlyIgnoreBlockedSubmit) {
        handleStaleSubmitBookingStepPrompt({
          callSid,
          realtimeState,
          turnGateReason: turnGate.reason || "UNKNOWN",
          submittedStepKey: clean(toolArgs.step_key),
          lastUserTranscript,
          requestRealtimeResponse,
        });
      } else {
        requestRealtimeResponse(
          {
            instructions: buildSubmitBookingStepNotReadyInstructions({
              realtimeState,
              reason: turnGate.reason || "UNKNOWN",
            }),
          },
          "tool_guard:submit_booking_step_turn_state"
        );
      }

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

    if (canBypassTurnGateForEarlyAnswerDuringAssistantPrompt) {
      console.warn("[VOICE_REALTIME][BOOKING_SUBMIT_ACCEPTED_EARLY_DURING_ASSISTANT_PROMPT]", {
        callSid,
        submittedStepKey,
        pendingStepKey,
        modelValue,
        lastUserTranscript,
        currentTranscriptSeq,
        promptAnchorSeq,
      });
    }

    if (!freshness.ok && !freshness.canAcceptModelValueDuringTranscriptRace) {
      return handleBlockedSubmitBookingStep({
        callSid,
        callId,
        openAiSocket,
        requestRealtimeResponse,
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

  if (toolName === "submit_booking_step") {
    effectiveToolArgs = applySubmitBookingStepEffectiveArgs({
      effectiveToolArgs,
      rawToolArgs: toolArgs,
      realtimeState,
      lastUserTranscript,
    });
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

    if (!isSyntheticToolCall) {
      sendRealtimeJson(openAiSocket, {
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: callId,
          output: JSON.stringify(toolResult),
        },
      });
    } else {
      console.log("[VOICE_REALTIME][SYNTHETIC_TOOL_OUTPUT_NOT_SENT_TO_OPENAI]", {
        callSid,
        toolName,
        callId,
        ok: toolResult?.ok,
        error: toolResult?.error,
        nextRequiredStepKey: clean(toolResult?.next_required_step?.step_key || ""),
        nextRequiredPrompt: clean(toolResult?.next_required_step?.prompt || ""),
      });

      const syntheticDirectInstructions =
        resolveSyntheticSubmitBookingStepFollowup({
          toolName,
          toolResult,
          currentLocale:
            clean((nextRealtimeState as any)?.lang) ||
            clean((realtimeState as any)?.lang) ||
            currentLocale,
        });

      if (syntheticDirectInstructions) {
        console.log("[VOICE_REALTIME][SYNTHETIC_DIRECT_FOLLOWUP_FORCED]", {
          callSid,
          toolName,
          callId,
          nextRequiredStepKey: clean(toolResult?.next_required_step?.step_key || ""),
          source: `tool_followup:${toolName}:synthetic_direct`,
        });

        requestRealtimeResponse(
          {
            instructions: syntheticDirectInstructions,
          },
          `tool_followup:${toolName}:synthetic_direct`
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
    }

    const followupLocale = String(
      (nextRealtimeState as any)?.lang ||
        (realtimeState as any)?.lang ||
        ""
    ).trim();

    const syntheticFollowupInstructions = isSyntheticToolCall
      ? buildSyntheticBookingStepFollowupInstructions({
          toolName,
          toolResult,
          currentLocale: followupLocale || currentLocale,
        })
      : "";

    const resolvedFollowupInstructions = resolveRealtimeToolFollowupInstructions({
      toolName,
      toolResult: (toolResult || {}) as RealtimeToolResult,
      currentLocale: followupLocale,
    });

    const nextRequiredPrompt = clean(toolResult?.next_required_step?.prompt || "");

    const fallbackNextStepInstructions =
      toolName === "submit_booking_step" && nextRequiredPrompt
        ? [
            "Ask the caller the next booking question using this configured prompt as the source of truth:",
            nextRequiredPrompt,
            "Ask only this one question.",
            "Do not repeat, reinterpret, or modify already collected booking details.",
            "Do not submit another booking step until the caller answers this current question.",
          ].join(" ")
        : "";

    const followupInstructions =
      syntheticFollowupInstructions ||
      resolvedFollowupInstructions ||
      fallbackNextStepInstructions;

    if (followupInstructions) {
      requestRealtimeResponse(
        {
          instructions: followupInstructions,
        },
        `tool_followup:${toolName}`
      );
    } else {
      console.warn("[VOICE_REALTIME][TOOL_FOLLOWUP_SKIPPED_EMPTY_INSTRUCTIONS]", {
        callSid,
        toolName,
        isSyntheticToolCall,
        ok: toolResult?.ok,
        error: toolResult?.error,
        nextRequiredStepKey: clean(toolResult?.next_required_step?.step_key || ""),
        nextRequiredPrompt,
      });
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