//src/lib/voice/handlers/handleVoiceInitialMenu.ts
import { twiml } from "twilio";
import type { CallState } from "../types";
import {
  normalizeSpeechOutput,
  sanitizeForSay,
  twoSentencesMax,
} from "../speechFormatting";
import { getVoiceMenuCopy } from "../voiceMenuCopy";
import { buildIntroByLanguage } from "../renderVoiceMenus";

type VoiceLocale = "es-ES" | "en-US" | "pt-BR";

type ResolveVoiceFn = (locale: string, configuredVoiceName?: string | null) => string;

type LogBotSayFn = (params: {
  callSid: string;
  to: string;
  text: string;
  lang?: string;
  context?: string;
}) => void;

type HandleVoiceInitialMenuParams = {
  vr: twiml.VoiceResponse;
  callSid: string;
  didNumber: string;
  state: CallState;
  langParam?: string;
  userInput: string;
  effectiveUserInput: string;
  digits: string;
  currentLocale: VoiceLocale;
  voiceName: string;
  tenantId: string;
  tenantBrand: string;
  cfg: Record<string, any>;
  resolveVoiceProviderVoice: ResolveVoiceFn;
  hasInitialVoiceIntroPlayed: (state: CallState) => boolean;
  logBotSay: LogBotSayFn;
};

type HandleVoiceInitialMenuResult = {
  handled: boolean;
  twiml?: string;
};

export async function handleVoiceInitialMenu(
  params: HandleVoiceInitialMenuParams
): Promise<HandleVoiceInitialMenuResult> {
  const {
    vr,
    callSid,
    didNumber,
    state,
    langParam,
    userInput,
    effectiveUserInput,
    digits,
    currentLocale,
    voiceName,
    tenantBrand,
    cfg,
    resolveVoiceProviderVoice,
    hasInitialVoiceIntroPlayed,
    logBotSay,
  } = params;

  // 1) Primer hit absoluto de la llamada:
  // intro en inglés + language selection
  if (!state.turn && !langParam && !userInput && !digits) {
    const menuCopy = getVoiceMenuCopy("en-US");

    const englishIntroText =
      (cfg?.welcome_message || "").trim() || menuCopy.englishIntroPrompt;

    const introXml = buildIntroByLanguage({
      selected: undefined,
      resolveVoice: resolveVoiceProviderVoice,
      locale: "en-US",
      englishIntroText,
    });

    return {
      handled: true,
      twiml: introXml,
    };
  }

  // 2) Menú inicial ya dentro del locale resuelto
  if (
    (state.turn ?? 0) + 1 === 1 &&
    !effectiveUserInput &&
    !digits &&
    !state.awaiting &&
    !state.awaitingNumber &&
    typeof state.bookingStepIndex !== "number"
  ) {
    const fallbackWelcome = currentLocale.startsWith("es")
      ? `Hola, soy Aamy del equipo de ${tenantBrand}. ¿En qué puedo ayudarte hoy?`
      : currentLocale.startsWith("pt")
      ? `Olá, aqui é a Aamy da equipe de ${tenantBrand}. Como posso te ajudar hoje?`
      : `Hi, this is Aamy from ${tenantBrand}. How can I help you today?`;

    const welcomeText = twoSentencesMax(
      (cfg?.welcome_message || "").trim() || fallbackWelcome
    );

    const mainMenuPrompt = String(
      cfg?.main_menu_prompt ||
        cfg?.menu_prompt ||
        cfg?.voice_menu_prompt ||
        ""
    ).trim();

    const menuText = mainMenuPrompt
      ? twoSentencesMax(mainMenuPrompt)
      : "";

    const shouldRepeatWelcome = !hasInitialVoiceIntroPlayed(state);

    const initialPromptText = sanitizeForSay(
      normalizeSpeechOutput(
        shouldRepeatWelcome
          ? [welcomeText, menuText].filter(Boolean).join(" ")
          : menuText || welcomeText,
        currentLocale as any
      )
    );

    const gather = vr.gather({
      input: ["speech", "dtmf"] as any,
      numDigits: 1,
      action: "/webhook/voice-response",
      method: "POST",
      language: currentLocale as any,
      speechTimeout: "1",
      timeout: 7,
      actionOnEmptyResult: true,
      bargeIn: true,
      enhanced: true,
      speechModel: "phone_call",
    });

    gather.say(
      { language: currentLocale as any, voice: voiceName as any },
      initialPromptText
    );

    logBotSay({
      callSid,
      to: didNumber || "ivr",
      text: initialPromptText,
      lang: currentLocale,
      context: shouldRepeatWelcome
        ? "welcome_with_main_menu_prompt"
        : "main_menu_prompt_after_initial_intro",
    });

    return {
      handled: true,
      twiml: vr.toString(),
    };
  }

  return { handled: false };
}