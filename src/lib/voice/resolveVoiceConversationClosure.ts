// src/lib/voice/resolveVoiceConversationClosure.ts

import { resolveVoiceMetaSignal } from "./resolveVoiceMetaSignal";

export type ResolveVoiceConversationClosureResult = {
  shouldClose: boolean;
};

export async function resolveVoiceConversationClosure(
  value: string,
  locale?: string | null
): Promise<ResolveVoiceConversationClosureResult> {
  const signal = await resolveVoiceMetaSignal({
    utterance: value,
    locale,
  });

  return {
    shouldClose: signal.intent === "close",
  };
}