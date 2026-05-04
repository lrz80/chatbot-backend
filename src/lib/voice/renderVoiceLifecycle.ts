// src/lib/voice/renderVoiceLifecycle.ts

import { SupportedVoiceLocale } from "./resolveVoiceLanguage";

export type VoiceLifecycleKey =
  | "language_selected_es"
  | "language_continue_en"
  | "menu_option_not_recognized"
  | "call_goodbye"
  | "generic_voice_unavailable"
  | "fatal_error_offer_sms"
  | "transfer_failed_sms_sent"
  | "transfer_failed_offer_sms";

function isSpanish(locale: SupportedVoiceLocale | string): boolean {
  return (locale || "").toLowerCase().startsWith("es");
}

function isPortuguese(locale: SupportedVoiceLocale | string): boolean {
  return (locale || "").toLowerCase().startsWith("pt");
}

export function renderVoiceLifecycle(
  key: VoiceLifecycleKey,
  locale: SupportedVoiceLocale | string
): string {
  if (isSpanish(locale)) {
    switch (key) {
      case "language_selected_es":
        return "Has seleccionado español.";

      case "language_continue_en":
        return "Continuamos en inglés.";

      case "menu_option_not_recognized":
        return "No reconocí esa opción.";

      case "call_goodbye":
        return "Gracias por tu llamada. ¡Hasta luego!";

      case "generic_voice_unavailable":
        return "Lo sentimos, no podemos atender esta llamada ahora.";

      case "fatal_error_offer_sms":
        return "Perdón, hubo un problema. ¿Quieres que te envíe la información por SMS? Di sí o pulsa 1.";

      case "transfer_failed_sms_sent":
        return "No se pudo completar la transferencia. Te envié el WhatsApp por SMS. ¿Algo más?";

      case "transfer_failed_offer_sms":
        return "No se pudo completar la transferencia. Si quieres, te envío el WhatsApp por SMS. Di sí o pulsa 1.";

      default:
        return "Perdón, hubo un problema.";
    }
  }

  if (isPortuguese(locale)) {
    switch (key) {
      case "language_selected_es":
        return "Idioma selecionado.";

      case "language_continue_en":
        return "Continuando em inglês.";

      case "menu_option_not_recognized":
        return "Não reconheci essa opção.";

      case "call_goodbye":
        return "Obrigado pela ligação. Até logo!";

      case "generic_voice_unavailable":
        return "Desculpe, não podemos atender esta ligação agora.";

      case "fatal_error_offer_sms":
        return "Desculpe, houve um problema. Quer que eu envie a informação por SMS? Diga sim ou pressione 1.";

      case "transfer_failed_sms_sent":
        return "Não foi possível completar a transferência. Enviei o WhatsApp por SMS. Posso ajudar em algo mais?";

      case "transfer_failed_offer_sms":
        return "Não foi possível completar a transferência. Se quiser, posso enviar o WhatsApp por SMS. Diga sim ou pressione 1.";

      default:
        return "Desculpe, houve um problema.";
    }
  }

  switch (key) {
    case "language_selected_es":
      return "Spanish selected.";

    case "language_continue_en":
      return "Continuing in English.";

    case "menu_option_not_recognized":
      return "I didn’t recognize that option.";

    case "call_goodbye":
      return "Thanks for calling. Goodbye!";

    case "generic_voice_unavailable":
      return "Sorry, we can’t take this call right now.";

    case "fatal_error_offer_sms":
      return "Sorry, there was a problem. Do you want me to text you the info? Say yes or press 1.";

    case "transfer_failed_sms_sent":
      return "The transfer could not be completed. I sent the WhatsApp link by SMS. Anything else?";

    case "transfer_failed_offer_sms":
      return "The transfer could not be completed. If you want, I can text you the WhatsApp link. Say yes or press 1.";

    default:
      return "Sorry, there was a problem.";
  }
}