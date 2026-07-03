// src/lib/voice/realtime/realtimeTranscriptHandler.ts
import type { CallState, VoiceLocale } from "../types";
import { detectarIdioma } from "../../detectarIdioma";
import { guardRealtimeUserTranscript } from "./transcriptGuards/guardRealtimeUserTranscript";

type RefreshRealtimeVoiceContextResult = {
  tenantId: string | null;
  tenant: any;
  cfg: any;
  brand: string;
  voiceName: string | null;
} | null;

type HandleRealtimeTranscriptEventParams = {
  event: any;
  callSid: string | null;
  didNumber: string | null;
  model: string;
  currentLocale: VoiceLocale;
  realtimeState: CallState;
  realtimeTenant: any;
  realtimeCfg: any;
  localeLocked: boolean;
  refreshRealtimeVoiceContext: (params: {
    callSid: string | null;
    didNumber: string | null;
    currentLocale: VoiceLocale;
    realtimeState: CallState;
  }) => Promise<RefreshRealtimeVoiceContextResult>;
  refreshRealtimeSession: (params: {
    openAiSocket: any;
    model: string;
    locale: VoiceLocale;
    businessName: string;
    businessInfo?: string | null;
    systemPrompt?: string | null;
  }) => { voice: string } | null;
  openAiSocket: any;
};

type HandleRealtimeTranscriptEventResult = {
  consumed: boolean;
  transcript: string;
  currentLocale: VoiceLocale;
  realtimeState: CallState;
  tenantId?: string | null;
  realtimeTenant?: any;
  realtimeCfg?: any;
  localeLocked: boolean;
};

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function mapDetectedLanguage(detectedLanguage?: string | null): string | null {
  const value = String(detectedLanguage || "").trim().toLowerCase();
  return value || null;
}

function mapLanguageToVoiceLocale(language: string): VoiceLocale {
  const value = language.trim().toLowerCase();

  if (value === "es") return "es-ES";
  if (value === "pt") return "pt-BR";

  return "en-US";
}

function shouldRejectWeakLanguageSwitch(params: {
  currentLanguage: string;
  detectedLanguage: string | null;
  confidence: number;
  tokenCount: number;
  localeLocked: boolean;
}): boolean {
  const {
    currentLanguage,
    detectedLanguage,
    confidence,
    tokenCount,
    localeLocked,
  } = params;

  if (!detectedLanguage) return true;
  if (detectedLanguage === currentLanguage) return true;
  if (localeLocked) return true;
  if (tokenCount < 3) return true;

  if (confidence >= 0.95) return false;

  if (
    currentLanguage &&
    currentLanguage !== "en" &&
    confidence < 0.95
  ) {
    return true;
  }

  return confidence < 0.85;
}

export async function handleRealtimeTranscriptEvent(
  params: HandleRealtimeTranscriptEventParams
): Promise<HandleRealtimeTranscriptEventResult> {
  const {
    event,
    callSid,
    didNumber,
    currentLocale,
    realtimeState,
    realtimeTenant,
    realtimeCfg,
    localeLocked,
    refreshRealtimeVoiceContext,
  } = params;

  const isUserTranscriptEvent =
    event?.type === "conversation.item.input_audio_transcription.completed";

  if (!isUserTranscriptEvent) {
    return {
      consumed: false,
      transcript: "",
      currentLocale,
      realtimeState,
      realtimeTenant,
      realtimeCfg,
      localeLocked,
    };
  }

  const transcript = clean(event.transcript || "");

  if (!transcript) {
    return {
      consumed: true,
      transcript: "",
      currentLocale,
      realtimeState,
      realtimeTenant,
      realtimeCfg,
      localeLocked,
    };
  }

  const transcriptGuard = guardRealtimeUserTranscript({
    transcript,
    realtimeState,
  });

  if (!transcriptGuard.ok) {
    console.log("[VOICE_REALTIME][USER_TRANSCRIPT_REJECTED_BY_GUARD]", {
      callSid,
      transcript,
      reason: transcriptGuard.reason,
      bookingTurnStatus: (realtimeState as any).bookingTurnStatus ?? null,
      pendingBookingStepKey: (realtimeState as any).pendingBookingStepKey ?? null,
      activeResponseId: (realtimeState as any).activeResponseId ?? null,
    });

    return {
      consumed: true,
      transcript: "",
      currentLocale,
      realtimeState,
      realtimeTenant,
      realtimeCfg,
      localeLocked,
    };
  }

  try {
    const detection = await detectarIdioma(transcript);

    const detectedLanguage = mapDetectedLanguage(detection?.lang || null);
    const confidence =
      typeof detection?.confidence === "number" ? detection.confidence : 0;

    const currentLanguage =
      clean((realtimeState as any).conversationLanguage) ||
      currentLocale.split("-")[0].toLowerCase();

    const tokenCount = transcript.split(/\s+/).filter(Boolean).length;

    const bookingFlowActive =
      Boolean((realtimeState as any).pendingBookingStepKey) ||
      ["waiting_assistant_prompt", "waiting_user_answer"].includes(
        clean((realtimeState as any).bookingTurnStatus)
      );

    const rejectSwitch = shouldRejectWeakLanguageSwitch({
      currentLanguage,
      detectedLanguage,
      confidence,
      tokenCount,
      localeLocked,
    });

    const shouldSwitch =
      !!detectedLanguage &&
      !rejectSwitch &&
      !bookingFlowActive;

    let nextLocale = currentLocale;
    let nextRealtimeState: CallState = realtimeState;
    let nextRealtimeTenant = realtimeTenant;
    let nextRealtimeCfg = realtimeCfg;
    let nextTenantId: string | null | undefined = undefined;
    let nextLocaleLocked = localeLocked;

    if (detectedLanguage && detectedLanguage !== currentLanguage && rejectSwitch) {
      console.log("[VOICE_REALTIME][LANGUAGE_SWITCH_REJECTED]", {
        callSid,
        transcript,
        detectedLanguage,
        currentLanguage,
        confidence,
        tokenCount,
        localeLocked,
        bookingFlowActive,
      });
    }

    if (shouldSwitch) {
      const voiceLocale = mapLanguageToVoiceLocale(detectedLanguage);

      nextLocaleLocked = true;
      nextLocale = voiceLocale;

      nextRealtimeState = {
        ...realtimeState,
        lang: nextLocale,
        conversationLanguage: detectedLanguage,
      } as CallState;

      try {
        const contextRefresh = await refreshRealtimeVoiceContext({
          callSid,
          didNumber,
          currentLocale: nextLocale,
          realtimeState: nextRealtimeState,
        });

        if (contextRefresh) {
          nextTenantId = contextRefresh.tenantId;
          nextRealtimeTenant = contextRefresh.tenant;
          nextRealtimeCfg = contextRefresh.cfg;
        }

        console.log("[VOICE_REALTIME][LANGUAGE_SWITCH]", {
          callSid,
          transcript,
          detectedLanguage,
          confidence,
          voiceLocale: nextLocale,
          conversationLanguage: detectedLanguage,
          previousLanguage: currentLanguage,
          tokenCount,
          sessionRefresh: "skipped_runtime_stability",
        });
      } catch (error) {
        console.error("[VOICE_REALTIME][CONTEXT_REFRESH_ERROR]", {
          callSid,
          locale: nextLocale,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      consumed: true,
      transcript,
      currentLocale: nextLocale,
      realtimeState: nextRealtimeState,
      tenantId: nextTenantId,
      realtimeTenant: nextRealtimeTenant,
      realtimeCfg: nextRealtimeCfg,
      localeLocked: nextLocaleLocked,
    };
  } catch (error) {
    console.error("[VOICE_REALTIME][LANGUAGE_DETECTION_ERROR]", {
      callSid,
      transcript,
      error: error instanceof Error ? error.message : String(error),
    });

    return {
      consumed: true,
      transcript,
      currentLocale,
      realtimeState,
      realtimeTenant,
      realtimeCfg,
      localeLocked,
    };
  }
}