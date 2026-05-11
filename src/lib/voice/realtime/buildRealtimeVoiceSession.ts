//src/lib/voice/realtime/buildRealtimeVoiceSession.ts
import { resolveVoiceProviderVoice } from "../resolveVoiceProviderVoice";

export type BuildRealtimeVoiceSessionParams = {
  businessName: string;
  businessInfo?: string | null;
  systemPrompt?: string | null;
  locale?: string;
};

export type RealtimeVoiceSessionConfig = {
  model: string;
  voice: string;
  instructions: string;
};

function buildLanguageInstruction(locale?: string): string {
  switch (locale) {
    case "es-ES":
      return `
Speak ONLY in Spanish.
Never switch languages unless the caller explicitly requests it.
`;

    case "pt-BR":
      return `
Speak ONLY in Brazilian Portuguese.
Never switch languages unless the caller explicitly requests it.
`;

    default:
      return `
Speak ONLY in English.
Never switch languages unless the caller explicitly requests it.
`;
  }
}

export function buildRealtimeVoiceSession({
  businessName,
  businessInfo,
  systemPrompt,
  locale,
}: BuildRealtimeVoiceSessionParams): RealtimeVoiceSessionConfig {
  const model =
    process.env.OPENAI_REALTIME_MODEL?.trim() ||
    "gpt-realtime";

  const configuredVoice =
    process.env.OPENAI_REALTIME_VOICE?.trim();

  const fallbackVoice = resolveVoiceProviderVoice(
    (locale as any) || "en-US"
  );

  const voice =
    configuredVoice ||
    String(fallbackVoice || "marin");

  const instructions = `
You are Aamy, a live phone assistant for ${businessName}.

${buildLanguageInstruction(locale)}

CORE BEHAVIOR:
- Speak naturally.
- Sound warm and human.
- Never sound robotic.
- Never sound like an IVR system.
- Use short conversational responses.
- Ask only one question at a time.
- Avoid long explanations unless requested.
- If audio is unclear, politely ask for clarification.
- Never invent business information.

CONVERSATION STYLE:
- Be conversational and relaxed.
- Avoid corporate phrases.
- Avoid "virtual assistant" wording.
- Avoid sounding scripted.
- Do not overexplain.

IMPORTANT:
- The caller is on a live phone call.
- Keep responses concise.
- Prioritize natural conversation flow.

BUSINESS NAME:
${businessName}

BUSINESS INFORMATION:
${businessInfo || "No business information provided."}

SYSTEM PROMPT:
${systemPrompt || "No custom system prompt provided."}
`.trim();

  return {
    model,
    voice,
    instructions,
  };
}