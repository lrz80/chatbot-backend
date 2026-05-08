//src/lib/voice/runtime/handleVoiceLanguageRoute.ts
import type { Request, Response } from "express";
import { twiml } from "twilio";

import pool from "../../db";
import { detectarIdioma } from "../../detectarIdioma";
import { getVoiceCallState } from "../getVoiceCallState";
import { upsertVoiceCallState } from "../upsertVoiceCallState";
import { renderVoiceLifecycle } from "../renderVoiceLifecycle";
import {
  resolveVoiceLanguageSelection,
} from "../resolveVoiceLanguage";
import { resolveVoiceProviderVoice } from "../resolveVoiceProviderVoice";

function withInitialVoiceIntroPlayed(
  bookingData: Record<string, any> | undefined
): Record<string, any> {
  return {
    ...(bookingData || {}),
    __voice_intro_played: "1",
  };
}

function normalizeDetectedVoiceLanguage(
  value: unknown
): "es" | "en" | "pt" | null {
  const candidate =
    typeof value === "object" && value !== null
      ? (value as any).lang ??
        (value as any).language ??
        (value as any).detectedLanguage ??
        (value as any).locale ??
        ""
      : value;

  const raw = String(candidate || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  if (!raw) return null;

  if (
    raw === "es" ||
    raw.startsWith("es-") ||
    raw.includes("spanish") ||
    raw.includes("espanol") ||
    raw.includes("castellano")
  ) {
    return "es";
  }

  if (
    raw === "pt" ||
    raw.startsWith("pt-") ||
    raw.includes("portuguese") ||
    raw.includes("portugues")
  ) {
    return "pt";
  }

  if (
    raw === "en" ||
    raw.startsWith("en-") ||
    raw.includes("english") ||
    raw.includes("ingles")
  ) {
    return "en";
  }

  return null;
}

export async function handleVoiceLanguageRoute(
  req: Request,
  res: Response
): Promise<Response> {
  const callSid = (req.body.CallSid || "").toString();

  const existingState = callSid ? await getVoiceCallState(callSid) : null;
  const existingLang =
    typeof existingState?.lang === "string" ? existingState.lang.trim() : "";

  if (existingLang) {
    const vr = new twiml.VoiceResponse();

    const langCode = existingLang.startsWith("es")
      ? "es"
      : existingLang.startsWith("pt")
      ? "pt"
      : "en";

    vr.redirect(`/webhook/voice-response?lang=${langCode}`);
    return res.type("text/xml").send(vr.toString());
  }

  const rawDigits = (req.body.Digits || "").toString().trim();
  const speechRaw = (req.body.SpeechResult || "").toString().trim();

  const langSelection = resolveVoiceLanguageSelection({
    digits: rawDigits,
    speech: speechRaw,
  });

  const detectedLanguageFromSpeech =
    langSelection.hasRealUtterance && !langSelection.explicitLanguageSelection
      ? await detectarIdioma(langSelection.originalSpeech).catch(() => null)
      : null;

  const normalizedDetectedLanguage =
    normalizeDetectedVoiceLanguage(detectedLanguageFromSpeech);

  let selectedLanguage: "es" | "en" | "pt" =
    langSelection.selectedLanguage === "es"
      ? "es"
      : langSelection.selectedLanguage === "pt"
      ? "pt"
      : "en";

  if (normalizedDetectedLanguage) {
    selectedLanguage = normalizedDetectedLanguage;
  }

  console.log(
    "[VOICE][LANG]",
    JSON.stringify({
      digits: rawDigits,
      speech: langSelection.normalizedSpeech,
      detectedLanguageFromSpeech,
      normalizedDetectedLanguage,
      selectedLanguage,
      bodyKeys: Object.keys(req.body || {}),
    })
  );

  const to = (req.body.To || "").toString().replace(/^tel:/, "");

  const tenantRes = await pool.query(
    `
      SELECT id
      FROM tenants
      WHERE twilio_voice_number = $1
      LIMIT 1
    `,
    [to]
  );

  const tenant = tenantRes.rows[0];

  const shouldCarryPendingUtterance =
    langSelection.hasRealUtterance && !langSelection.explicitLanguageSelection;

  if (tenant && callSid) {
    await upsertVoiceCallState({
      callSid,
      tenantId: tenant.id,
      lang:
        selectedLanguage === "es"
          ? "es-ES"
          : selectedLanguage === "pt"
          ? "pt-BR"
          : "en-US",
      turn: 0,
      awaiting: false,
      pendingType: null,
      awaitingNumber: false,
      altDest: null,
      smsSent: false,
      bookingStepIndex: null,
      bookingData: shouldCarryPendingUtterance
        ? withInitialVoiceIntroPlayed({
            __pending_utterance: langSelection.originalSpeech,
          })
        : {},
    });
  }

  const vr = new twiml.VoiceResponse();

  const selectedLocale =
    selectedLanguage === "es"
      ? "es-ES"
      : selectedLanguage === "pt"
      ? "pt-BR"
      : "en-US";

  if (langSelection.explicitLanguageSelection) {
    if (selectedLocale === "es-ES") {
      vr.say(
        {
          language: "es-ES",
          voice: resolveVoiceProviderVoice("es-ES") as any,
        },
        renderVoiceLifecycle("language_selected_es", "es-ES")
      );
      vr.redirect("/webhook/voice-response?lang=es");
      return res.type("text/xml").send(vr.toString());
    }

    if (selectedLocale === "pt-BR") {
      vr.redirect("/webhook/voice-response?lang=pt");
      return res.type("text/xml").send(vr.toString());
    }

    vr.redirect("/webhook/voice-response?lang=en");
    return res.type("text/xml").send(vr.toString());
  }

  if (langSelection.hasRealUtterance) {
    vr.redirect(
      `/webhook/voice-response?lang=${
        selectedLanguage === "es"
          ? "es"
          : selectedLanguage === "pt"
          ? "pt"
          : "en"
      }`
    );
    return res.type("text/xml").send(vr.toString());
  }

  vr.redirect("/webhook/voice-response?lang=en");
  return res.type("text/xml").send(vr.toString());
}