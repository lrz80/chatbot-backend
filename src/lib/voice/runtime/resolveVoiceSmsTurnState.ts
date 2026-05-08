//src/lib/voice/runtime/resolveVoiceSmsTurnState.ts
import { upsertVoiceCallState } from "../upsertVoiceCallState";
import { renderVoiceReply } from "../renderVoiceReply";
import { resolveVoiceSmsFlow } from "../resolveVoiceSmsFlow";
import { resolveVoiceMetaSignal } from "../resolveVoiceMetaSignal";
import { resolveVoiceMenuSelection } from "../resolveVoiceMenuSelection";
import type { CallState, LinkType, VoiceLocale } from "../types";

type ResolveVoiceSmsTurnStateParams = {
  effectiveUserInput: string;
  digits: string;
  state: CallState;
  currentLocale: VoiceLocale;
  hasActiveBookingStep: boolean;
  assistantReply: string | null;
  callSid: string;
  tenantId: string;
};

export type ResolveVoiceSmsTurnStateResult = {
  state: CallState;
  digits: string;
  smsType: LinkType | null;
  thisTurnMetaSignal: {
    intent: string;
    confidence: number;
  };
  rejectedReplyText: string | null;
};

export async function resolveVoiceSmsTurnState(
  params: ResolveVoiceSmsTurnStateParams
): Promise<ResolveVoiceSmsTurnStateResult> {
  const {
    effectiveUserInput,
    digits: initialDigits,
    state: initialState,
    currentLocale,
    hasActiveBookingStep,
    assistantReply,
    callSid,
    tenantId,
  } = params;

  let state = initialState;
  let digits = initialDigits;
  let smsType: LinkType | null = null;

  const earlyMetaSignal = !hasActiveBookingStep
    ? await resolveVoiceMetaSignal({
        utterance: effectiveUserInput,
        locale: currentLocale,
      })
    : { intent: "other", confidence: 0 };

  if (
    state.awaiting &&
    effectiveUserInput &&
    earlyMetaSignal.intent !== "affirm" &&
    earlyMetaSignal.intent !== "reject"
  ) {
    const nextDigit = await resolveVoiceMenuSelection({
      utterance: effectiveUserInput,
      locale: currentLocale,
    });

    state = {
      ...state,
      awaiting: false,
      pendingType: null,
    };

    await upsertVoiceCallState({
      callSid,
      tenantId,
      lang: state.lang ?? currentLocale,
      turn: state.turn ?? 0,
      awaiting: false,
      pendingType: null,
      awaitingNumber: state.awaitingNumber ?? false,
      altDest: state.altDest ?? null,
      smsSent: state.smsSent ?? false,
      bookingStepIndex: state.bookingStepIndex ?? null,
      bookingData: state.bookingData ?? {},
    });

    if (nextDigit) {
      digits = nextDigit;
    }
  }

  const earlySmsFlow = !hasActiveBookingStep
    ? await resolveVoiceSmsFlow({
        effectiveUserInput,
        digits,
        awaiting: !!state.awaiting,
        pendingType: state.pendingType ?? null,
        assistantReply: null,
      })
    : {
        confirmed: false,
        rejected: false,
        shouldSendNow: false,
        resolvedType: null,
        newlyRequested: false,
        shouldKeepPending: false,
        nextPendingType: null,
      };

  if (state.awaiting && (earlySmsFlow.confirmed || earlySmsFlow.rejected)) {
    state = {
      ...state,
      awaiting: false,
      pendingType: null,
    };

    await upsertVoiceCallState({
      callSid,
      tenantId,
      lang: state.lang ?? currentLocale,
      turn: state.turn ?? 0,
      awaiting: false,
      pendingType: null,
      awaitingNumber: state.awaitingNumber ?? false,
      altDest: state.altDest ?? null,
      smsSent: state.smsSent ?? false,
      bookingStepIndex: state.bookingStepIndex ?? null,
      bookingData: state.bookingData ?? {},
    });
  }

  if (earlySmsFlow.confirmed && earlySmsFlow.shouldSendNow) {
    smsType = earlySmsFlow.resolvedType;
  }

  if (earlySmsFlow.rejected) {
    return {
      state,
      digits,
      smsType,
      thisTurnMetaSignal: {
        intent: "reject",
        confidence: 1,
      },
      rejectedReplyText: renderVoiceReply("fallback_not_understood", {
        locale: currentLocale,
      }),
    };
  }

  const resolvedSmsFlow = await resolveVoiceSmsFlow({
    effectiveUserInput,
    digits,
    awaiting: !!state.awaiting,
    pendingType: state.pendingType ?? null,
    assistantReply,
  });

  if (!smsType && resolvedSmsFlow.shouldSendNow) {
    smsType = resolvedSmsFlow.resolvedType;
  }

  if (!smsType && resolvedSmsFlow.rejected && state.awaiting) {
    state = {
      ...state,
      awaiting: false,
      pendingType: null,
    };

    await upsertVoiceCallState({
      callSid,
      tenantId,
      lang: state.lang ?? currentLocale,
      turn: state.turn ?? 0,
      awaiting: false,
      pendingType: null,
      awaitingNumber: state.awaitingNumber ?? false,
      altDest: state.altDest ?? null,
      smsSent: state.smsSent ?? false,
      bookingStepIndex: state.bookingStepIndex ?? null,
      bookingData: state.bookingData ?? {},
    });
  }

  if (!smsType && resolvedSmsFlow.newlyRequested) {
    smsType = resolvedSmsFlow.resolvedType;
  }

  if (!smsType && resolvedSmsFlow.shouldKeepPending && resolvedSmsFlow.nextPendingType) {
    const ask = renderVoiceReply("sms_offer_confirmation", {
      locale: currentLocale,
      linkType: resolvedSmsFlow.nextPendingType,
    });

    await upsertVoiceCallState({
      callSid,
      tenantId,
      lang: state.lang ?? currentLocale,
      turn: state.turn ?? 0,
      awaiting: true,
      pendingType: resolvedSmsFlow.nextPendingType,
      awaitingNumber: state.awaitingNumber ?? false,
      altDest: state.altDest ?? null,
      smsSent: state.smsSent ?? false,
      bookingStepIndex: state.bookingStepIndex ?? null,
      bookingData: state.bookingData ?? {},
    });

    state = {
      ...state,
      awaiting: true,
      pendingType: resolvedSmsFlow.nextPendingType,
    };

    return {
      state,
      digits,
      smsType,
      thisTurnMetaSignal: await resolveVoiceMetaSignal({
        utterance: effectiveUserInput,
        locale: currentLocale,
      }),
      rejectedReplyText: ask,
    };
  }

  const thisTurnMetaSignal = await resolveVoiceMetaSignal({
    utterance: effectiveUserInput,
    locale: currentLocale,
  });

  return {
    state,
    digits,
    smsType,
    thisTurnMetaSignal,
    rejectedReplyText: null,
  };
}