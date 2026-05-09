//src/lib/voice/booking/types.ts
import { twiml } from "twilio";
import { CallState, VoiceLocale } from "../types";
import { getBookingFlow } from "../../appointments/getBookingFlow";

export type BookingFlow = Awaited<ReturnType<typeof getBookingFlow>>;

export type BookingStep = BookingFlow[number];

export type BookingStepHandlerResult =
  | {
      handled: false;
      state: CallState;
    }
  | {
      handled: true;
      state: CallState;
      twiml: string;
    };

export type CreateBookingGatherFn = (params: {
  vr: twiml.VoiceResponse;
  locale: VoiceLocale;
  step?: BookingStep | null;
  isPhoneStep?: boolean;
  isConfirmationStep?: boolean;
  hints?: string;
  timeout?: number;
  bargeIn?: boolean;
}) => ReturnType<twiml.VoiceResponse["gather"]>;

export type VoiceBotSayLogger = (input: {
  callSid: string;
  to: string;
  text: string;
  lang?: string;
  context?: string;
}) => void;