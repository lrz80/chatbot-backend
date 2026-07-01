// src/lib/voice/renderVoiceReply.ts

import { LinkType } from "./types";

type RenderVoiceReplyKey =
  | "sms_offer_confirmation"
  | "sms_sent_success"
  | "sms_ask_destination_number"
  | "sms_invalid_destination_number"
  | "sms_send_error"
  | "transfer_connecting"
  | "transfer_unavailable"
  | "assistant_unavailable"
  | "voice_channel_unavailable"
  | "fallback_not_understood";

type RenderVoiceReplyParams = {
  locale?: string | null;
  linkType?: LinkType | null;
};

type VoiceReplyDictionary = Partial<
  Record<string, Partial<Record<RenderVoiceReplyKey, string>>>
>;

/**
 * Runtime-safe fallback dictionary.
 *
 * This is not the final multilingual system.
 * The production version should load these texts from tenant/global config,
 * not from hardcoded language branches.
 */
const DEFAULT_VOICE_REPLIES: VoiceReplyDictionary = {
  "en-US": {
    sms_offer_confirmation:
      'Do you want me to text it to you? Say "yes" or press 1.',
    sms_sent_success: "Done, I just texted you the link. Anything else?",
    sms_ask_destination_number:
      "What number should I text? Please include country code or key it in now.",
    sms_invalid_destination_number:
      "I couldn’t catch that number. Please include the country code or key it in now.",
    sms_send_error: "I couldn’t send the text right now.",
    transfer_connecting:
      "Connecting you to a representative. One moment, please.",
    transfer_unavailable: "I can’t transfer you right now.",
    assistant_unavailable:
      "The assistant for this number is not available at the moment. Thank you for calling.",
    voice_channel_unavailable:
      "The voice assistant for this number is not available at the moment. Thank you for calling.",
    fallback_not_understood: "Sorry, I didn’t catch that.",
  },
};

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function resolveVoiceReplyText(params: {
  key: RenderVoiceReplyKey;
  locale?: string | null;
  dictionary: VoiceReplyDictionary;
}): string | null {
  const locale = clean(params.locale) || "en-US";

  return (
    params.dictionary[locale]?.[params.key] ||
    params.dictionary["en-US"]?.[params.key] ||
    null
  );
}

export function renderVoiceReply(
  key: RenderVoiceReplyKey,
  params: RenderVoiceReplyParams
): string {
  const text = resolveVoiceReplyText({
    key,
    locale: params.locale,
    dictionary: DEFAULT_VOICE_REPLIES,
  });

  if (text) {
    return text;
  }

  return params.linkType
    ? "Do you want me to text it to you?"
    : "Sorry, I didn’t catch that.";
}