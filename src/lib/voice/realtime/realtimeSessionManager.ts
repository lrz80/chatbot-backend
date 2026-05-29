//src/lib/voice/realtime/realtimeSessionManager.ts
import WebSocket from "ws";
import { buildRealtimeVoiceSession } from "./buildRealtimeVoiceSession";
import { buildOpenAiRealtimeSessionUpdate } from "./buildOpenAiRealtimeSessionUpdate";
import { resolveVoiceRequestContext } from "../runtime/resolveVoiceRequestContext";
import type { CallState } from "../types";

export type VoiceLocale = "en-US" | "es-ES" | "pt-BR";

export type RefreshRealtimeVoiceContextResult = {
  tenantId: string | null;
  tenant: any;
  cfg: any;
  brand: string;
  voiceName: string | null;
} | null;

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function sendJson(socket: WebSocket, payload: Record<string, unknown>): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(payload));
}

export function normalizeLocale(locale?: string): VoiceLocale {
  const value = String(locale || "").trim().toLowerCase();

  if (value.startsWith("es")) return "es-ES";
  if (value.startsWith("pt")) return "pt-BR";

  return "en-US";
}

export function buildInitialGreetingInstruction(params: {
  brand: string;
  locale?: string;
}): string {
  const normalized = normalizeLocale(params.locale);

  if (normalized === "es-ES") {
    return `Greet the caller in Spanish for ${params.brand}. Keep it short and natural.`;
  }

  if (normalized === "pt-BR") {
    return `Greet the caller in Brazilian Portuguese for ${params.brand}. Keep it short and natural.`;
  }

  return `Greet the caller in English for ${params.brand}. Keep it short and natural.`;
}

export function resolveConfiguredWelcomeMessage(params: {
  cfg: any;
  tenant: any;
}): string {
  const cfgWelcome =
    clean(params.cfg?.welcome_message) ||
    clean(params.cfg?.welcomeMessage) ||
    clean(params.cfg?.mensaje_bienvenida) ||
    clean(params.cfg?.bienvenida);

  if (cfgWelcome) {
    return cfgWelcome;
  }

  const tenantWelcome =
    clean(params.tenant?.welcome_message) ||
    clean(params.tenant?.welcomeMessage) ||
    clean(params.tenant?.mensaje_bienvenida) ||
    clean(params.tenant?.bienvenida);

  return tenantWelcome;
}

export function buildInitialGreetingFromConfiguredWelcome(params: {
  configuredWelcome: string;
  brand: string;
  locale: VoiceLocale;
}): string {
  const configuredWelcome = clean(params.configuredWelcome);

  if (!configuredWelcome) {
    return buildInitialGreetingInstruction({
      brand: params.brand,
      locale: params.locale,
    });
  }

  return [
    "Use only this configured welcome message as the source of truth.",
    "Say it naturally as the first greeting of the phone call.",
    "Do not replace it with a generic greeting.",
    "Do not invent another business name.",
    "Do not add menu options unless they are already included in the configured welcome message.",
    `Configured welcome message: ${configuredWelcome}`,
  ].join(" ");
}

export function refreshRealtimeSession(params: {
  openAiSocket: WebSocket;
  model: string;
  locale: VoiceLocale;
  businessName: string;
  businessInfo?: string | null;
  systemPrompt?: string | null;
}): { voice: string } | null {
  if (params.openAiSocket.readyState !== WebSocket.OPEN) return null;

  const session = buildRealtimeVoiceSession({
    businessName: params.businessName,
    businessInfo: params.businessInfo || "",
    systemPrompt: params.systemPrompt || "",
    locale: params.locale,
  });

  sendJson(
    params.openAiSocket,
    buildOpenAiRealtimeSessionUpdate({
      instructions: session.instructions,
      voice: session.voice,
      model: params.model,
    })
  );

  return {
    voice: session.voice,
  };
}

export async function refreshRealtimeVoiceContext(params: {
  callSid: string | null;
  didNumber: string | null;
  currentLocale: VoiceLocale;
  realtimeState: CallState;
}): Promise<RefreshRealtimeVoiceContextResult> {
  if (!params.callSid || !params.didNumber) return null;

  const context = await resolveVoiceRequestContext({
    callSid: params.callSid,
    didNumber: params.didNumber,
    state: {
      ...params.realtimeState,
      lang: params.currentLocale,
    },
    langParam:
      params.currentLocale === "es-ES"
        ? "es"
        : params.currentLocale === "pt-BR"
        ? "pt"
        : "en",
    channelKey: "voice",
  });

  if (!context.ok) {
    return null;
  }

  return {
    tenantId: context.tenant.id,
    tenant: context.tenant,
    cfg: context.cfg || {},
    brand: context.brand,
    voiceName: context.voiceName || null,
  };
}

export async function resolveInitialRealtimeSessionContext(params: {
  callSid: string | null;
  didNumber: string | null;
  realtimeState: CallState;
}): Promise<
  | {
      ok: true;
      tenantId: string;
      tenant: any;
      cfg: any;
      brand: string;
    }
  | {
      ok: false;
    }
> {
  if (!params.callSid || !params.didNumber) {
    return { ok: false };
  }

  const context = await resolveVoiceRequestContext({
    callSid: params.callSid,
    didNumber: params.didNumber,
    state: params.realtimeState,
    langParam: undefined,
    channelKey: "voice",
  });

  if (!context.ok) {
    return { ok: false };
  }

  return {
    ok: true,
    tenantId: context.tenant.id,
    tenant: context.tenant,
    cfg: context.cfg || {},
    brand: context.brand || context.tenant.name || "the business",
  };
}

export function buildRealtimeSessionUpdatePayload(params: {
  businessName: string;
  businessInfo?: string | null;
  systemPrompt?: string | null;
  locale: VoiceLocale;
  model: string;
}): Record<string, unknown> {
  const session = buildRealtimeVoiceSession({
    businessName: params.businessName,
    businessInfo: params.businessInfo || "",
    systemPrompt: params.systemPrompt || "",
    locale: params.locale,
  });

  return buildOpenAiRealtimeSessionUpdate({
    instructions: session.instructions,
    voice: session.voice,
    model: params.model,
  });
}