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

  const explicitFarewell =
    /\b(hasta luego|hasta pronto|adios|bye|goodbye|chao|nos vemos)\b/u.test(s);

  const explicitConversationEnd =
    /\b(eso es todo|nada mas|no gracias eso es todo|no gracias nada mas)\b/u.test(s);

  return {
    shouldClose: explicitFarewell || explicitConversationEnd,
  };
}