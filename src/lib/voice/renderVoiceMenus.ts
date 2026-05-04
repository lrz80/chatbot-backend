// src/lib/voice/renderVoiceMenus.ts

import { twiml } from "twilio";
import { SupportedVoiceLocale } from "./resolveVoiceLanguage";
import { getVoiceMenuCopy } from "./voiceMenuCopy";

type ResolveVoiceFn = (locale: string, cfgVoice?: string) => any;

type BuildIntroByLanguageParams = {
  selected?: string;
  resolveVoice: ResolveVoiceFn;
  locale?: SupportedVoiceLocale;
  englishIntroText: string;
};

type BuildMainMenuParams = {
  vr: twiml.VoiceResponse;
  locale: SupportedVoiceLocale;
  voiceName: any;
  brand: string;
  greetingText: string;
  menuPrompt?: string;
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

function normalizePrompt(value: string): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function assertNonEmptyMenuText(value: string, field: string): string {
  const text = normalizePrompt(value);

  if (!text) {
    throw new Error(`VOICE_MENU_EMPTY_TEXT:${field}`);
  }

  return text;
}

export function buildIntroByLanguage({
  selected,
  resolveVoice,
  locale = "en-US",
  englishIntroText,
}: BuildIntroByLanguageParams): string {
  const vr = new twiml.VoiceResponse();
  const copy = getVoiceMenuCopy(locale);

  const safeEnglishIntro = assertNonEmptyMenuText(
    englishIntroText,
    "englishIntroText"
  );

  const safeSpanishSelectionPrompt = assertNonEmptyMenuText(
    copy.spanishSelectionPrompt,
    "spanishSelectionPrompt"
  );

  const safeSpanishConfirmedPrompt = assertNonEmptyMenuText(
    copy.spanishConfirmedPrompt,
    "spanishConfirmedPrompt"
  );

  if (selected === "es") {
    vr.say(
      { language: "es-ES", voice: resolveVoice("es-ES") as any },
      safeSpanishConfirmedPrompt
    );
    vr.redirect("/webhook/voice-response?lang=es");
    return vr.toString();
  }

  vr.say(
    { language: "en-US", voice: resolveVoice("en-US") as any },
    safeEnglishIntro
  );

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
    safeSpanishSelectionPrompt
  );

  vr.redirect("/webhook/voice-response/lang?fallback=en");

  return vr.toString();
}

export function buildMainMenu({
  vr,
  locale,
  voiceName,
  greetingText,
  menuPrompt,
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

  const safeGreeting = assertNonEmptyMenuText(greetingText, "greetingText");
  const safeMenuText = assertNonEmptyMenuText(menuPrompt || "", "menuPrompt");

  const line = `${safeGreeting} ${safeMenuText}`.trim();

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