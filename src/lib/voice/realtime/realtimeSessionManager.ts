// src/lib/voice/realtime/realtimeSessionManager.ts
import WebSocket from "ws";
import { buildRealtimeVoiceSession } from "./buildRealtimeVoiceSession";
import { buildOpenAiRealtimeSessionUpdate } from "./buildOpenAiRealtimeSessionUpdate";
import { resolveVoiceRequestContext } from "../runtime/resolveVoiceRequestContext";
import { tenantHasUsefulLinks } from "../runtime/sendUsefulLinkSms";
import type { CallState, VoiceLocale } from "../types";

export type RefreshRealtimeVoiceContextResult = {
  tenantId: string | null;
  tenant: any;
  cfg: any;
  brand: string;
  voiceName: string | null;
  canSendUsefulLinkSms: boolean;
} | null;

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function sendJson(socket: WebSocket, payload: Record<string, unknown>): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(payload));
}

export function normalizeLocale(locale?: string): VoiceLocale {
  const value = String(locale || "").trim();

  if (!value) {
    return "en-US";
  }

  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasEnabledUsefulLink(value: unknown): boolean {
  if (typeof value === "string") {
    return clean(value).length > 0;
  }

  if (Array.isArray(value)) {
    return value.some((item) => hasEnabledUsefulLink(item));
  }

  if (!isPlainObject(value)) {
    return false;
  }

  const enabledValue = value.enabled ?? value.is_enabled ?? value.active;
  const explicitlyDisabled =
    enabledValue === false ||
    enabledValue === 0 ||
    String(enabledValue ?? "").trim().toLowerCase() === "false";

  if (explicitlyDisabled) {
    return false;
  }

  const directUrl =
    clean(value.url) ||
    clean(value.href) ||
    clean(value.link) ||
    clean(value.booking_url) ||
    clean(value.bookingUrl) ||
    clean(value.appointment_url) ||
    clean(value.appointmentUrl) ||
    clean(value.square_booking_url) ||
    clean(value.squareBookingUrl);

  if (directUrl) {
    return true;
  }

  return false;
}

export function resolveCanSendUsefulLinkSms(params: {
  cfg: any;
  tenant: any;
}): boolean {
  const cfg = params.cfg || {};
  const tenant = params.tenant || {};

  const candidates = [
    cfg.useful_links,
    cfg.usefulLinks,
    cfg.links,
    cfg.links?.booking_url,
    cfg.links?.bookingUrl,
    cfg.links?.booking?.booking_url,
    cfg.links?.booking?.bookingUrl,

    cfg.booking_links,
    cfg.bookingLinks,
    cfg.booking_url,
    cfg.bookingUrl,
    cfg.appointment_url,
    cfg.appointmentUrl,
    cfg.square_booking_url,
    cfg.squareBookingUrl,

    cfg.settings?.booking?.booking_url,
    cfg.settings?.booking?.bookingUrl,
    cfg.settings?.booking?.appointment_url,
    cfg.settings?.booking?.appointmentUrl,
    cfg.settings?.booking?.square_booking_url,
    cfg.settings?.booking?.squareBookingUrl,

    tenant.useful_links,
    tenant.usefulLinks,
    tenant.links,
    tenant.links?.booking_url,
    tenant.links?.bookingUrl,
    tenant.links?.booking?.booking_url,
    tenant.links?.booking?.bookingUrl,

    tenant.booking_links,
    tenant.bookingLinks,
    tenant.booking_url,
    tenant.bookingUrl,
    tenant.appointment_url,
    tenant.appointmentUrl,
    tenant.square_booking_url,
    tenant.squareBookingUrl,

    tenant.settings?.booking?.booking_url,
    tenant.settings?.booking?.bookingUrl,
    tenant.settings?.booking?.appointment_url,
    tenant.settings?.booking?.appointmentUrl,
    tenant.settings?.booking?.square_booking_url,
    tenant.settings?.booking?.squareBookingUrl,
  ];

  return candidates.some((candidate) => hasEnabledUsefulLink(candidate));
}

export function buildInitialGreetingInstruction(params: {
  brand: string;
  locale?: string;
}): string {
  const locale = normalizeLocale(params.locale);

  return [
    `Greet the caller for ${params.brand}.`,
    `Use the caller/session locale: ${locale}.`,
    "Keep it short, natural, and conversational.",
    "Do not invent another business name.",
  ].join(" ");
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
  canSendUsefulLinkSms?: boolean;
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
      canSendUsefulLinkSms: params.canSendUsefulLinkSms === true,
    })
  );

  return {
    voice: session.voice,
  };
}

export function localeToLanguageParam(locale?: string): string | undefined {
  const normalized = normalizeLocale(locale);
  const language = normalized.split("-")[0]?.trim().toLowerCase();

  return language || undefined;
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
    langParam: localeToLanguageParam(params.currentLocale),
    channelKey: "voice",
  });

  if (!context.ok) {
    return null;
  }

  const cfg = context.cfg || {};
  const tenant = context.tenant;

  const canSendUsefulLinkSms =
    resolveCanSendUsefulLinkSms({
      cfg,
      tenant,
    }) || (await tenantHasUsefulLinks(tenant.id));

  return {
    tenantId: tenant.id,
    tenant,
    cfg,
    brand: context.brand,
    voiceName: context.voiceName || null,
    canSendUsefulLinkSms,
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
      canSendUsefulLinkSms: boolean;
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

  const cfg = context.cfg || {};
  const tenant = context.tenant;

  const canSendUsefulLinkSms =
    resolveCanSendUsefulLinkSms({
      cfg,
      tenant,
    }) || (await tenantHasUsefulLinks(tenant.id));

  return {
    ok: true,
    tenantId: tenant.id,
    tenant,
    cfg,
    brand: context.brand || tenant.name || "the business",
    canSendUsefulLinkSms,
  };
}

export function buildRealtimeSessionUpdatePayload(params: {
  businessName: string;
  businessInfo?: string | null;
  systemPrompt?: string | null;
  locale: VoiceLocale;
  model: string;
  canSendUsefulLinkSms?: boolean;
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
    canSendUsefulLinkSms: params.canSendUsefulLinkSms === true,
  });
}