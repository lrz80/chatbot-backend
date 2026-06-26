// src/lib/voice/realtime/bookingStep/resolveGlobalConfirmationIntent.ts
import pool from "../../../db";

export type ConfirmationIntent = "confirm" | "cancel" | "unknown";

type ResolveGlobalConfirmationIntentParams = {
  locale: string;
  values: unknown[];
};

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeIntentText(value: unknown): string {
  return clean(value)
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .toLowerCase()
    .trim();
}

function normalizeLocaleParts(locale: string): string[] {
  const cleanLocale = clean(locale);
  const lowerLocale = cleanLocale.toLowerCase();
  const languageOnly = lowerLocale.split("-")[0] || "";

  return Array.from(
    new Set([cleanLocale, lowerLocale, languageOnly, "*"].filter(Boolean))
  );
}

function asProtocolIntent(value: unknown): ConfirmationIntent | "" {
  const normalized = normalizeIntentText(value);

  if (normalized === "confirm" || normalized === "confirmed") {
    return "confirm";
  }

  if (
    normalized === "cancel" ||
    normalized === "canceled" ||
    normalized === "cancelled"
  ) {
    return "cancel";
  }

  if (normalized === "unknown") {
    return "unknown";
  }

  return "";
}

export async function resolveGlobalConfirmationIntent(
  params: ResolveGlobalConfirmationIntentParams
): Promise<ConfirmationIntent | ""> {
  for (const value of params.values) {
    const protocolIntent = asProtocolIntent(value);

    if (protocolIntent) {
      return protocolIntent;
    }
  }

  const normalizedValues = Array.from(
    new Set(params.values.map(normalizeIntentText).filter(Boolean))
  );

  if (normalizedValues.length === 0) {
    return "";
  }

  const localeCandidates = normalizeLocaleParts(params.locale);

  const result = await pool.query(
    `
    SELECT intent, phrase
    FROM booking_confirmation_intents
    WHERE is_active = true
      AND locale = ANY($1::text[])
    `,
    [localeCandidates]
  );

  for (const row of result.rows) {
    const intent = clean(row.intent) as ConfirmationIntent;
    const normalizedPhrase = normalizeIntentText(row.phrase);

    if (!normalizedPhrase) continue;

    if (normalizedValues.includes(normalizedPhrase)) {
      return intent;
    }
  }

  return "";
}