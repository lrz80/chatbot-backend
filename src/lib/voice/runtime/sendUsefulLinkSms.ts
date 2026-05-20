// src/lib/voice/runtime/sendUsefulLinkSms.ts
import pool from "../../db";
import { sendSMS } from "../../senders/sms";
import { upsertVoiceCallState } from "../upsertVoiceCallState";
import type { CallState, VoiceLocale } from "../types";
import { isValidE164 } from "./voiceSmsRuntime";

type TenantSmsConfig = {
  id: string;
  name?: string | null;
  twilio_sms_number?: string | null;
  twilio_voice_number?: string | null;
};

type UsefulLink = {
  id: string;
  tipo: string;
  nombre: string;
  url: string;
};

export type SendUsefulLinkSmsParams = {
  tenant: TenantSmsConfig;
  callSid: string;
  currentLocale: VoiceLocale;
  state: CallState;
  callerE164: string | null;
  linkTypes?: string[];
};

export type SendUsefulLinkSmsResult = {
  sent: boolean;
  updatedState: CallState;
  error?: string;
  link?: UsefulLink;
};

const DEFAULT_BOOKING_LINK_TYPES = [
  "booking",
  "square_booking",
  "appointments",
  "appointment_booking",
  "booking_link",
];

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeLinkTypes(values?: string[]): string[] {
  const normalized = (values || DEFAULT_BOOKING_LINK_TYPES)
    .map((value) => clean(value).toLowerCase())
    .filter(Boolean);

  return normalized.length > 0 ? normalized : DEFAULT_BOOKING_LINK_TYPES;
}

async function findUsefulLinkForTenant(params: {
  tenantId: string;
  linkTypes?: string[];
}): Promise<UsefulLink | null> {
  const linkTypes = normalizeLinkTypes(params.linkTypes);

  const { rows } = await pool.query(
    `
    SELECT
      id,
      tipo,
      nombre,
      url
    FROM links_utiles
    WHERE tenant_id = $1
      AND LOWER(TRIM(tipo)) = ANY($2::text[])
      AND NULLIF(TRIM(url), '') IS NOT NULL
    ORDER BY
      CASE LOWER(TRIM(tipo))
        WHEN 'booking' THEN 1
        WHEN 'square_booking' THEN 2
        WHEN 'appointments' THEN 3
        WHEN 'appointment_booking' THEN 4
        WHEN 'booking_link' THEN 5
        ELSE 99
      END ASC,
      nombre ASC
    LIMIT 1
    `,
    [params.tenantId, linkTypes]
  );

  const row = rows[0];

  if (!row) return null;

  return {
    id: clean(row.id),
    tipo: clean(row.tipo),
    nombre: clean(row.nombre),
    url: clean(row.url),
  };
}

function buildUsefulLinkSmsBody(params: {
  tenant: TenantSmsConfig;
  link: UsefulLink;
  locale: VoiceLocale;
}): string {
  const businessName = clean(params.tenant.name);
  const linkName = clean(params.link.nombre) || clean(params.link.tipo);
  const url = clean(params.link.url);

  if (params.locale.startsWith("es")) {
    return [
      businessName || null,
      linkName ? `Enlace: ${linkName}` : "Enlace de reserva",
      url,
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (params.locale.startsWith("pt")) {
    return [
      businessName || null,
      linkName ? `Link: ${linkName}` : "Link de agendamento",
      url,
    ]
      .filter(Boolean)
      .join("\n");
  }

  return [
    businessName || null,
    linkName ? `Link: ${linkName}` : "Booking link",
    url,
  ]
    .filter(Boolean)
    .join("\n");
}

async function persistUsefulLinkSmsState(params: {
  tenantId: string;
  callSid: string;
  state: CallState;
  currentLocale: VoiceLocale;
}): Promise<CallState> {
  const nextState: CallState = {
    ...params.state,
    awaiting: false,
    pendingType: null,
    smsSent: true,
    bookingData: {
      ...(params.state.bookingData || {}),
      useful_link_sms_sent: "true",
    },
  };

  await upsertVoiceCallState({
    callSid: params.callSid,
    tenantId: params.tenantId,
    lang: nextState.lang ?? params.currentLocale,
    turn: nextState.turn ?? 0,
    awaiting: false,
    pendingType: null,
    awaitingNumber: nextState.awaitingNumber ?? false,
    altDest: nextState.altDest ?? null,
    smsSent: true,
    bookingStepIndex:
      typeof nextState.bookingStepIndex === "number"
        ? nextState.bookingStepIndex
        : null,
    bookingData: nextState.bookingData || {},
  });

  return nextState;
}

export async function sendUsefulLinkSms(
  params: SendUsefulLinkSmsParams
): Promise<SendUsefulLinkSmsResult> {
  const tenantId = clean(params.tenant.id);
  const smsFrom =
    clean(params.tenant.twilio_sms_number) ||
    clean(params.tenant.twilio_voice_number);

  const toDest =
    params.state.altDest && isValidE164(params.state.altDest)
      ? params.state.altDest
      : params.callerE164;

  if (!tenantId) {
    return {
      sent: false,
      updatedState: params.state,
      error: "TENANT_ID_MISSING",
    };
  }

  if (!toDest || !isValidE164(toDest)) {
    return {
      sent: false,
      updatedState: params.state,
      error: "INVALID_SMS_DESTINATION",
    };
  }

  if (!smsFrom) {
    return {
      sent: false,
      updatedState: params.state,
      error: "SMS_FROM_NUMBER_MISSING",
    };
  }

  if (smsFrom.startsWith("whatsapp:")) {
    return {
      sent: false,
      updatedState: params.state,
      error: "SMS_FROM_NUMBER_IS_WHATSAPP_ONLY",
    };
  }

  const link = await findUsefulLinkForTenant({
    tenantId,
    linkTypes: params.linkTypes,
  });

  if (!link) {
    return {
      sent: false,
      updatedState: params.state,
      error: "USEFUL_LINK_NOT_CONFIGURED",
    };
  }

  const body = buildUsefulLinkSmsBody({
    tenant: params.tenant,
    link,
    locale: params.currentLocale,
  });

  console.log("[VOICE][USEFUL_LINK_SMS][SEND_ATTEMPT]", {
    callSid: params.callSid,
    tenantId,
    smsFrom,
    toDest,
    linkType: link.tipo,
    linkName: link.nombre,
  });

  const sentCount = await sendSMS({
    mensaje: body,
    destinatarios: [toDest],
    fromNumber: smsFrom || undefined,
    tenantId,
    campaignId: null,
  });

  console.log("[VOICE][USEFUL_LINK_SMS][SENT]", {
    callSid: params.callSid,
    tenantId,
    sentCount,
    toDest,
    linkType: link.tipo,
  });

  const updatedState = await persistUsefulLinkSmsState({
    tenantId,
    callSid: params.callSid,
    state: params.state,
    currentLocale: params.currentLocale,
  });

  return {
    sent: sentCount > 0,
    updatedState,
    link,
  };
}