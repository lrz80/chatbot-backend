// src/lib/voice/renderVoiceMenus.ts

import { twiml } from "twilio";
import { SupportedVoiceLocale } from "./resolveVoiceLanguage";

type ResolveVoiceFn = (locale: string, cfgVoice?: string) => any;

type BuildIntroByLanguageParams = {
  selected?: string;
  brand?: string;
  resolveVoice: ResolveVoiceFn;
};

type BuildMainMenuParams = {
  vr: twiml.VoiceResponse;
  locale: SupportedVoiceLocale;
  voiceName: any;
  brand: string;
  greetingText: string;
  callSid?: string;
  toNumber?: string;
  logBotSay?: (input: {
    callSid: string;
    to: string;
    text: string;
    lang?: string;
    context?: string;
  }) => void;
};

export function buildIntroByLanguage({
  selected,
  brand,
  resolveVoice,
}: BuildIntroByLanguageParams): string {
  const vr = new twiml.VoiceResponse();

  const business = brand && brand.trim().length > 0 ? brand.trim() : undefined;

  if (selected === "es") {
    const lineEs = business
      ? `Hola, soy Amy del equipo de ${business}. Continuamos en español.`
      : "Hola, soy Amy. Continuamos en español.";

    vr.say({ language: "es-ES", voice: resolveVoice("es-ES") as any }, lineEs);
    vr.redirect("/webhook/voice-response?lang=es");
    return vr.toString();
  }

  const lineEn = business
    ? `Hi, this is Amy from ${business}.`
    : "Hi, this is Amy.";

  vr.say({ language: "en-US", voice: resolveVoice("en-US") as any }, lineEn);

  const gather = vr.gather({
    input: ["dtmf", "speech"] as any,
    numDigits: 1,
    timeout: 6,
    language: "es-ES" as any,
    speechTimeout: "auto",
    enhanced: true,
    speechModel: "phone_call",
    hints: "español, espanol, dos, 2",
    action: "/webhook/voice-response/lang",
    method: "POST",
    actionOnEmptyResult: true,
    bargeIn: true,
  });

  gather.say(
    { language: "es-ES", voice: resolveVoice("es-ES") as any },
    'Para español, marque dos o diga "Español".'
  );

  vr.redirect("/webhook/voice-response/lang?fallback=en");

  return vr.toString();
}

export function buildMainMenu({
  vr,
  locale,
  voiceName,
  brand,
  greetingText,
  callSid,
  toNumber,
  logBotSay,
}: BuildMainMenuParams): void {
  const gather = vr.gather({
    input: ["dtmf", "speech"] as any,
    numDigits: 1,
    action: "/webhook/voice-response",
    method: "POST",
    language: locale as any,
    speechTimeout: "auto",
    bargeIn: true,
    actionOnEmptyResult: true,
    timeout: 4,
  });

  const menuText = locale.startsWith("es")
    ? "Puedes decirme que quieres agendar una cita, o marcar 1 para precios, 2 para horarios o 3 para ubicación."
    : "You can tell me you want to book an appointment, or press 1 for prices, 2 for hours, or 3 for location.";

  const fallbackGreeting = locale.startsWith("es")
    ? `Hola, soy Amy del equipo de ${brand}.`
    : `Hi, I'm Amy from ${brand}.`;

  const safeGreeting = (greetingText || "").trim() || fallbackGreeting;
  const line = `${safeGreeting} ${menuText}`.trim();

  gather.say({ language: locale as any, voice: voiceName }, line);

  if (logBotSay) {
    logBotSay({
      callSid: callSid || "N/A",
      to: toNumber || "ivr",
      text: line,
      lang: locale,
      context: "menu",
    });
  }
}