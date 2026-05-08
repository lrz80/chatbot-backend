//src/lib/voice/runtime/resolveVoiceBusinessInfoFastpath.ts
import pool from "../../db";
import { resolveBusinessInfoFacetsCanonicalBody } from "../../channels/engine/businessInfo/resolveBusinessInfoFacetsCanonicalBody";
import type { VoiceIntent } from "../resolveVoiceIntentFromUtterance";
import type { VoiceLocale } from "../types";

type LangCode = "es" | "en" | "pt";

type ResolveVoiceBusinessInfoFastpathParams = {
  tenantId: string;
  currentLocale: VoiceLocale;
  intent: VoiceIntent;
  userInput: string;
  infoClave: string;
  promptBaseMem?: string;
};

export type ResolveVoiceBusinessInfoFastpathResult =
  | {
      handled: false;
    }
  | {
      handled: true;
      respuesta: string;
      source: "info_clave_db";
      intent: "ubicacion" | "horario";
    };

function toTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function toLangCode(locale: VoiceLocale): LangCode {
  const normalized = String(locale || "").trim().toLowerCase();

  if (normalized.startsWith("en")) return "en";
  if (normalized.startsWith("pt")) return "pt";
  return "es";
}

export async function resolveVoiceBusinessInfoFastpath({
  tenantId,
  currentLocale,
  intent,
  userInput,
  infoClave,
  promptBaseMem = "",
}: ResolveVoiceBusinessInfoFastpathParams): Promise<ResolveVoiceBusinessInfoFastpathResult> {
  const normalizedInfoClave = toTrimmedString(infoClave);
  const normalizedPromptBaseMem = toTrimmedString(promptBaseMem);
  const normalizedUserInput = toTrimmedString(userInput);

  if (!normalizedUserInput) {
    return { handled: false };
  }

  if (!normalizedInfoClave && !normalizedPromptBaseMem) {
    return { handled: false };
  }

  const idiomaDestino = toLangCode(currentLocale);

  if (intent === "location") {
    const canonicalBody = await resolveBusinessInfoFacetsCanonicalBody({
      pool,
      tenantId,
      canal: "voice",
      idiomaDestino,
      userInput: normalizedUserInput,
      promptBaseMem: normalizedPromptBaseMem,
      infoClave: normalizedInfoClave,
      facets: {
        asksSchedules: false,
        asksLocation: true,
        asksAvailability: false,
      },
    });

    const respuesta = toTrimmedString(canonicalBody);

    if (!respuesta) {
      return { handled: false };
    }

    return {
      handled: true,
      respuesta,
      source: "info_clave_db",
      intent: "ubicacion",
    };
  }

  if (intent === "hours") {
    const canonicalBody = await resolveBusinessInfoFacetsCanonicalBody({
      pool,
      tenantId,
      canal: "voice",
      idiomaDestino,
      userInput: normalizedUserInput,
      promptBaseMem: normalizedPromptBaseMem,
      infoClave: normalizedInfoClave,
      facets: {
        asksSchedules: true,
        asksLocation: false,
        asksAvailability: false,
      },
    });

    const respuesta = toTrimmedString(canonicalBody);

    if (!respuesta) {
      return { handled: false };
    }

    return {
      handled: true,
      respuesta,
      source: "info_clave_db",
      intent: "horario",
    };
  }

  return { handled: false };
}