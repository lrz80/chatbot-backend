// src/lib/voice/realtime/bookingStep/resolvers/resolveRealtimePhoneValue.ts
import { clean } from "../../realtimeBookingFlowUtils";

export const USE_CALLER_PHONE_TOKEN = "__USE_CALLER_PHONE__";

export const PHONE_CONFIRM_USE_INBOUND = "use_inbound_caller";
export const PHONE_CONFIRM_REPLACE = "replace_phone";
export const PHONE_CONFIRM_UNKNOWN = "unknown";

type ResolveRealtimePhoneValueParams = {
  value: string;
  rawTranscriptValue: string;
  modelValue: string;
  callerPhone: string | null;
};

export type ResolveRealtimePhoneValueResult =
  | {
      ok: true;
      value: string;
      source: "caller_phone" | "spoken_phone";
    }
  | {
      ok: false;
      error: "PHONE_REQUIRED" | "INVALID_PHONE_VALUE";
      value: "";
      source: "none";
    };

function normalizeProtocolValue(value: unknown): string {
  return clean(value).toLowerCase();
}

function normalizePhoneToE164(value: string): string {
  const raw = clean(value);

  if (!raw) {
    return "";
  }

  if (raw.startsWith("+")) {
    const digits = raw.slice(1).replace(/\D/g, "");
    return digits ? `+${digits}` : "";
  }

  const digits = raw.replace(/\D/g, "");

  if (digits.length === 10) {
    return `+1${digits}`;
  }

  if (digits.length === 11 && digits.startsWith("1")) {
    return `+${digits}`;
  }

  return "";
}

function isValidE164Phone(value: string): boolean {
  return /^\+[1-9]\d{7,14}$/.test(value);
}

function isUseCallerPhoneProtocol(value: string): boolean {
  const normalized = normalizeProtocolValue(value);

  return (
    normalized === USE_CALLER_PHONE_TOKEN ||
    normalized === PHONE_CONFIRM_USE_INBOUND
  );
}

function isRejectOrUnknownPhoneProtocol(value: string): boolean {
  const normalized = normalizeProtocolValue(value);

  return (
    normalized === PHONE_CONFIRM_REPLACE ||
    normalized === PHONE_CONFIRM_UNKNOWN
  );
}

function resolveCallerPhone(callerPhoneValue: string | null): ResolveRealtimePhoneValueResult {
  const callerPhone = normalizePhoneToE164(callerPhoneValue || "");

  if (!isValidE164Phone(callerPhone)) {
    return {
      ok: false,
      error: "PHONE_REQUIRED",
      value: "",
      source: "none",
    };
  }

  return {
    ok: true,
    value: callerPhone,
    source: "caller_phone",
  };
}

/**
 * Generic voice phone resolver.
 *
 * It does not infer consent from natural language.
 *
 * Valid phone sources are:
 * - an explicit submitted/spoken phone number
 * - the real caller phone only when the tool submits an internal protocol value:
 *   - USE_CALLER_PHONE_TOKEN
 *   - PHONE_CONFIRM_USE_INBOUND
 *
 * It does NOT compare against words like "yes", "sí", "ok", etc.
 */
export function resolveRealtimePhoneValue(
  params: ResolveRealtimePhoneValueParams
): ResolveRealtimePhoneValueResult {
  const value = clean(params.value);
  const modelValue = clean(params.modelValue);
  const rawTranscriptValue = clean(params.rawTranscriptValue);

  if (isUseCallerPhoneProtocol(value) || isUseCallerPhoneProtocol(modelValue)) {
    return resolveCallerPhone(params.callerPhone);
  }

  if (
    isRejectOrUnknownPhoneProtocol(value) ||
    isRejectOrUnknownPhoneProtocol(modelValue)
  ) {
    return {
      ok: false,
      error: "INVALID_PHONE_VALUE",
      value: "",
      source: "none",
    };
  }

  const submittedPhone = normalizePhoneToE164(value);

  if (isValidE164Phone(submittedPhone)) {
    return {
      ok: true,
      value: submittedPhone,
      source: "spoken_phone",
    };
  }

  const modelPhone = normalizePhoneToE164(modelValue);

  if (isValidE164Phone(modelPhone)) {
    return {
      ok: true,
      value: modelPhone,
      source: "spoken_phone",
    };
  }

  const transcriptPhone = normalizePhoneToE164(rawTranscriptValue);

  if (isValidE164Phone(transcriptPhone)) {
    return {
      ok: true,
      value: transcriptPhone,
      source: "spoken_phone",
    };
  }

  return {
    ok: false,
    error: "INVALID_PHONE_VALUE",
    value: "",
    source: "none",
  };
}