// src/lib/voice/resolveVoiceConversationClosure.ts

import { resolveVoiceMetaSignal } from "./resolveVoiceMetaSignal";

export type ResolveVoiceConversationClosureResult = {
  shouldClose: boolean;
};

type ResolveVoiceConversationClosureOptions = {
  allowRejectAsClose?: boolean;
};

export async function resolveVoiceConversationClosure(
  value: string,
  locale?: string | null,
  options?: ResolveVoiceConversationClosureOptions
): Promise<ResolveVoiceConversationClosureResult> {
  const signal = await resolveVoiceMetaSignal({
    utterance: value,
    locale,
  });

  const shouldClose =
    signal.intent === "close" ||
    (options?.allowRejectAsClose === true && signal.intent === "reject");

  return {
    shouldClose,
  };
}