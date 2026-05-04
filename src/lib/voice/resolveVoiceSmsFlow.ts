// src/lib/voice/resolveVoiceSmsFlow.ts

import { LinkType } from "./types";
import {
  askedForSms,
  didAssistantPromiseSms,
  guessLinkType,
  saidNo,
  saidYes,
} from "./resolveVoiceTurnSignals";

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

export function resolveVoiceSmsFlow(
  input: ResolveVoiceSmsFlowInput
): ResolveVoiceSmsFlowResult {
  const effectiveUserInput = input.effectiveUserInput || "";
  const digits = (input.digits || "").trim();
  const assistantReply = input.assistantReply || "";

  const confirmation = saidYes(effectiveUserInput) || digits === "1";
  const rejection = saidNo(effectiveUserInput) || digits === "2";

  const newlyRequested = askedForSms(effectiveUserInput);
  const promisedByAssistant = didAssistantPromiseSms(assistantReply);

  let resolvedType: LinkType | null = null;
  let shouldSendNow = false;
  let shouldKeepPending = false;
  let nextPendingType: LinkType | null = null;

  if (input.awaiting && confirmation) {
    resolvedType = input.pendingType || guessLinkType(effectiveUserInput);
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
    resolvedType = guessLinkType(effectiveUserInput);
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
    const inferredType = guessLinkType(`${effectiveUserInput} ${assistantReply}`);

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