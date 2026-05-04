// src/lib/voice/resolveVoiceSmsFlow.ts

import { LinkType } from "./types";
import { resolveVoiceMetaSignal } from "./resolveVoiceMetaSignal";
import { resolveVoiceSmsIntent } from "./resolveVoiceSmsIntent";
import { resolveVoiceLinkType } from "./resolveVoiceLinkType";

export type ResolveVoiceSmsFlowInput = {
  effectiveUserInput: string;
  digits?: string | null;
  awaiting: boolean;
  pendingType?: LinkType | null;
  assistantReply?: string | null;
};

export type ResolveVoiceSmsFlowResult = {
  confirmed: boolean;
  rejected: boolean;
  newlyRequested: boolean;
  promisedByAssistant: boolean;
  resolvedType: LinkType | null;
  shouldSendNow: boolean;
  shouldKeepPending: boolean;
  nextPendingType: LinkType | null;
};

export async function resolveVoiceSmsFlow(
  input: ResolveVoiceSmsFlowInput
): Promise<ResolveVoiceSmsFlowResult> {
  const effectiveUserInput = input.effectiveUserInput || "";
  const digits = (input.digits || "").trim();
  const assistantReply = input.assistantReply || "";

  const metaSignal = await resolveVoiceMetaSignal({
    utterance: effectiveUserInput,
  });

  const smsIntent = await resolveVoiceSmsIntent({
    userUtterance: effectiveUserInput,
    assistantUtterance: assistantReply,
  });

  const confirmation =
    digits === "1" || metaSignal.intent === "affirm";

  const rejection =
    digits === "2" || metaSignal.intent === "reject";

  const newlyRequested = smsIntent.userRequestedSms;
  const promisedByAssistant = smsIntent.assistantPromisedSms;

  let resolvedType: LinkType | null = null;
  let shouldSendNow = false;
  let shouldKeepPending = false;
  let nextPendingType: LinkType | null = null;

  if (input.awaiting && confirmation) {
    resolvedType =
      input.pendingType ||
      (await resolveVoiceLinkType({
        utterance: effectiveUserInput,
        fallback: "reservar",
      }));

    shouldSendNow = true;
    nextPendingType = null;

    return {
      confirmed: true,
      rejected: false,
      newlyRequested,
      promisedByAssistant,
      resolvedType,
      shouldSendNow,
      shouldKeepPending,
      nextPendingType,
    };
  }

  if (input.awaiting && rejection) {
    return {
      confirmed: false,
      rejected: true,
      newlyRequested,
      promisedByAssistant,
      resolvedType: null,
      shouldSendNow: false,
      shouldKeepPending: false,
      nextPendingType: null,
    };
  }

  if (newlyRequested) {
    resolvedType = await resolveVoiceLinkType({
      utterance: effectiveUserInput,
      fallback: "reservar",
    });

    shouldSendNow = true;
    nextPendingType = null;

    return {
      confirmed: confirmation,
      rejected: rejection,
      newlyRequested: true,
      promisedByAssistant,
      resolvedType,
      shouldSendNow,
      shouldKeepPending: false,
      nextPendingType,
    };
  }

  if (promisedByAssistant) {
    const inferredType = await resolveVoiceLinkType({
      utterance: `${effectiveUserInput} ${assistantReply}`.trim(),
      fallback: "reservar",
    });

    if (confirmation) {
      return {
        confirmed: true,
        rejected: false,
        newlyRequested,
        promisedByAssistant: true,
        resolvedType: inferredType,
        shouldSendNow: true,
        shouldKeepPending: false,
        nextPendingType: null,
      };
    }

    if (!rejection) {
      return {
        confirmed: false,
        rejected: false,
        newlyRequested,
        promisedByAssistant: true,
        resolvedType: null,
        shouldSendNow: false,
        shouldKeepPending: true,
        nextPendingType: inferredType,
      };
    }
  }

  return {
    confirmed: confirmation,
    rejected: rejection,
    newlyRequested,
    promisedByAssistant,
    resolvedType: null,
    shouldSendNow: false,
    shouldKeepPending: false,
    nextPendingType: null,
  };
}