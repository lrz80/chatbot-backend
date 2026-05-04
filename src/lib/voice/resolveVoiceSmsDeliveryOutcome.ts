// src/lib/voice/resolveVoiceSmsDeliveryOutcome.ts

import { SupportedVoiceLocale } from "./resolveVoiceLanguage";
import { SendVoiceLinkSmsResult } from "./sendVoiceLinkSms";

export type ResolveVoiceSmsDeliveryOutcomeResult = {
  appendText: string;
};

function isSpanish(locale: SupportedVoiceLocale | string): boolean {
  return (locale || "").toLowerCase().startsWith("es");
}

function isPortuguese(locale: SupportedVoiceLocale | string): boolean {
  return (locale || "").toLowerCase().startsWith("pt");
}

export function resolveVoiceSmsDeliveryOutcome(
  result: SendVoiceLinkSmsResult,
  locale: SupportedVoiceLocale | string
): ResolveVoiceSmsDeliveryOutcomeResult {
  if (result.ok) {
    if (isSpanish(locale)) {
      return { appendText: " Te lo acabo de enviar por SMS." };
    }

    if (isPortuguese(locale)) {
      return { appendText: " Acabei de enviar por SMS." };
    }

    return { appendText: " I just texted it to you." };
  }

  if (result.code === "LINK_NOT_FOUND") {
    if (isSpanish(locale)) {
      return { appendText: " No encontré un enlace registrado para eso." };
    }

    if (isPortuguese(locale)) {
      return { appendText: " Não encontrei um link registrado para isso." };
    }

    return { appendText: " I couldn’t find a saved link for that." };
  }

  if (result.code === "INVALID_DESTINATION") {
    if (isSpanish(locale)) {
      return { appendText: " No pude validar tu número para enviarte el SMS." };
    }

    if (isPortuguese(locale)) {
      return { appendText: " Não consegui validar seu número para enviar o SMS." };
    }

    return { appendText: " I could not validate your number to text you." };
  }

  if (result.code === "SMS_FROM_MISSING") {
    if (isSpanish(locale)) {
      return { appendText: " No hay un número SMS configurado para enviar el enlace." };
    }

    if (isPortuguese(locale)) {
      return { appendText: " Não há um número SMS configurado para enviar o link." };
    }

    return { appendText: " There is no SMS-capable number configured to send the link." };
  }

  if (result.code === "SMS_FROM_WHATSAPP_ONLY") {
    if (isSpanish(locale)) {
      return { appendText: " El número configurado es WhatsApp y no puede enviar SMS." };
    }

    if (isPortuguese(locale)) {
      return { appendText: " O número configurado é apenas WhatsApp e não pode enviar SMS." };
    }

    return { appendText: " The configured number is WhatsApp-only and cannot send SMS." };
  }

  if (isSpanish(locale)) {
    return { appendText: " Hubo un problema al enviar el SMS." };
  }

  if (isPortuguese(locale)) {
    return { appendText: " Houve um problema ao enviar o SMS." };
  }

  return { appendText: " There was a problem sending the text." };
}