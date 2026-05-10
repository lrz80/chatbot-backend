// src/lib/voice/buildVoiceGatherConfig.ts

type BuildVoiceGatherConfigParams = {
  locale: string;
  action?: string;
  numDigits?: number;
  timeout?: number;
  bargeIn?: boolean;
  hints?: string;
};

export function buildVoiceGatherConfig({
  locale,
  action = "/webhook/voice-response",
  numDigits,
  timeout = 4,
  bargeIn,
  hints,
}: BuildVoiceGatherConfigParams) {
  return {
    input: ["speech", "dtmf"] as any[],
    action,
    method: "POST" as const,
    language: locale as any,
    actionOnEmptyResult: true,
    speechModel: "phone_call" as const,
    speechTimeout: "auto",
    timeout,
    ...(typeof numDigits === "number" ? { numDigits } : {}),
    ...(typeof bargeIn === "boolean" ? { bargeIn } : {}),
    ...(typeof hints === "string" && hints.trim()
      ? { hints: hints.trim() }
      : {}),
  };
}