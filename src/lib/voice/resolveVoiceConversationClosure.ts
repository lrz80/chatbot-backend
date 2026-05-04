// src/lib/voice/resolveVoiceConversationClosure.ts

export type ResolveVoiceConversationClosureResult = {
  shouldClose: boolean;
};

function normalizeText(value: string): string {
  return (value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function resolveVoiceConversationClosure(
  value: string
): ResolveVoiceConversationClosureResult {
  const s = normalizeText(value);

  const shouldClose = /\b(gracias|eso es todo|nada mas|bye|adios)\b/u.test(s);

  return {
    shouldClose,
  };
}