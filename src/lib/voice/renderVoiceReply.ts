// src/lib/voice/renderVoiceReply.ts

import { LinkType } from "./types";
import { SupportedVoiceLocale } from "./resolveVoiceLanguage";

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
  locale: SupportedVoiceLocale;
  linkType?: LinkType | null;
};

function isSpanish(locale: SupportedVoiceLocale): boolean {
  return locale.startsWith("es");
}

function isPortuguese(locale: SupportedVoiceLocale): boolean {
  return locale.startsWith("pt");
}

export function renderVoiceReply(
  key: RenderVoiceReplyKey,
  params: RenderVoiceReplyParams
): string {
  const { locale, linkType } = params;

  if (isSpanish(locale)) {
    switch (key) {
      case "sms_offer_confirmation":
        return '¿Quieres que te lo envíe por SMS? Di "sí" o pulsa 1.';

      case "sms_sent_success":
        return "Listo, te envié el enlace por SMS. ¿Algo más?";

      case "sms_ask_destination_number":
        return "¿A qué número te lo envío? Dímelo con el código de país o márcalo ahora.";

      case "sms_invalid_destination_number":
        return "No pude tomar ese número. Dímelo con código de país o márcalo ahora.";

      case "sms_send_error":
        return "No pude enviar el SMS ahora mismo.";

      case "transfer_connecting":
        return "Te comunico con un representante. Un momento, por favor.";

      case "transfer_unavailable":
        return "Ahora mismo no puedo transferirte.";

      case "assistant_unavailable":
        return "En este momento no hay asistente disponible en este número. Gracias por llamar.";

      case "voice_channel_unavailable":
        return "En este momento no hay asistente de voz disponible en este número. Gracias por llamar.";

      case "fallback_not_understood":
        return "Disculpa, no entendí eso.";

      default:
        return linkType
          ? "¿Quieres que te lo envíe por SMS?"
          : "Disculpa, no entendí eso.";
    }
  }

  if (isPortuguese(locale)) {
    switch (key) {
      case "sms_offer_confirmation":
        return 'Quer que eu envie por SMS? Diga "sim" ou pressione 1.';

      case "sms_sent_success":
        return "Pronto, enviei o link por SMS. Posso ajudar em algo mais?";

      case "sms_ask_destination_number":
        return "Para qual número devo enviar? Diga com o código do país ou digite agora.";

      case "sms_invalid_destination_number":
        return "Não consegui entender esse número. Diga com o código do país ou digite agora.";

      case "sms_send_error":
        return "Não consegui enviar o SMS agora.";

      case "transfer_connecting":
        return "Vou transferir você para um representante. Um momento, por favor.";

      case "transfer_unavailable":
        return "No momento não consigo transferir você.";

      case "assistant_unavailable":
        return "No momento não há assistente disponível neste número. Obrigado pela ligação.";

      case "voice_channel_unavailable":
        return "No momento o assistente de voz não está disponível neste número. Obrigado pela ligação.";

      case "fallback_not_understood":
        return "Desculpe, não entendi isso.";

      default:
        return linkType
          ? "Quer que eu envie por SMS?"
          : "Desculpe, não entendi isso.";
    }
  }

  switch (key) {
    case "sms_offer_confirmation":
      return 'Do you want me to text it to you? Say "yes" or press 1.';

    case "sms_sent_success":
      return "Done, I just texted you the link. Anything else?";

    case "sms_ask_destination_number":
      return "What number should I text? Please include country code or key it in now.";

    case "sms_invalid_destination_number":
      return "I couldn’t catch that number. Please include the country code or key it in now.";

    case "sms_send_error":
      return "I couldn’t send the text right now.";

    case "transfer_connecting":
      return "Connecting you to a representative. One moment, please.";

    case "transfer_unavailable":
      return "I can’t transfer you right now.";

    case "assistant_unavailable":
      return "The assistant for this number is not available at the moment. Thank you for calling.";

    case "voice_channel_unavailable":
      return "The voice assistant for this number is not available at the moment. Thank you for calling.";

    case "fallback_not_understood":
      return "Sorry, I didn’t catch that.";

    default:
      return linkType
        ? "Do you want me to text it to you?"
        : "Sorry, I didn’t catch that.";
  }
}