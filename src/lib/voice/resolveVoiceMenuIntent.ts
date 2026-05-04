// src/lib/voice/resolveVoiceMenuIntent.ts

import { LinkType } from "./types";
import { SupportedVoiceLocale } from "./resolveVoiceLanguage";

export type VoiceMenuTopic = "precios" | "horarios" | "ubicacion" | "pagos";

export type VoiceMenuIntentResult =
  | {
      kind: "snippet";
      topic: VoiceMenuTopic;
      linkType: LinkType;
    }
  | {
      kind: "transfer";
    }
  | null;

export function resolveVoiceMenuIntent(
  digit: string,
  _locale: SupportedVoiceLocale
): VoiceMenuIntentResult {
  switch ((digit || "").trim()) {
    case "1":
      return {
        kind: "snippet",
        topic: "precios",
        linkType: "comprar",
      };

    case "2":
      return {
        kind: "snippet",
        topic: "horarios",
        linkType: "web",
      };

    case "3":
      return {
        kind: "snippet",
        topic: "ubicacion",
        linkType: "web",
      };

    case "4":
      return {
        kind: "transfer",
      };

    default:
      return null;
  }
}