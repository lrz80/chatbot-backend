//src/lib/voice/types.ts
export type VoiceLocale = "es-ES" | "en-US" | "pt-BR";

export type LinkType = "reservar" | "comprar" | "soporte" | "web";

export type CallState = {
  awaiting?: boolean;
  pendingType?: LinkType | null;
  awaitingNumber?: boolean;
  altDest?: string | null;
  smsSent?: boolean;
  lang?: VoiceLocale;
  turn?: number;
  bookingStepIndex?: number;
  bookingData?: Record<string, string>;
};

export type PhoneResolutionResult =
  | { ok: true; value: string }
  | { ok: false };

export type VoiceBookingServiceOption = {
  value: string;
  aliases: string[];
};

export type VoiceBookingServiceResolution =
  | { kind: "resolved_single"; value: string }
  | { kind: "ambiguous"; options: string[] }
  | { kind: "none" };