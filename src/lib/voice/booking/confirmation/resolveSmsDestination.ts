//src/lib/voice/booking/confirmation/resolveSmsDestination.ts
import type { CallState } from "../../types";

export function resolveSmsDestination(params: {
  state: CallState;
  callerE164: string | null;
}): string {
  const { state, callerE164 } = params;

  const fromState = [
    state.bookingData?.customer_phone,
    state.bookingData?.phone,
    callerE164,
  ]
    .map((value) => String(value || "").trim())
    .find((value) => value.length >= 7);

  return fromState || "";
}