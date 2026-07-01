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

const DEFAULT_USEFUL_LINK_TYPES = [
  "booking",
  "appointment",
  "appointments",
  "square_booking",
  "appointment_booking",
  "booking_link",
  "location",
  "address",
  "maps",
  "google_maps",
  "ubicacion",
  "dirección",
  "direccion",
  "payment",
  "pay",
  "pagar",
  "website",
  "site",
  "menu",
  "quote",
  "estimate",
];

const USEFUL_LINK_TYPE_ALIASES: Record<string, string[]> = {
  booking: [
    "booking",
    "book",
    "appointment",
    "appointments",
    "appointment_booking",
    "booking_link",
    "square_booking",
    "reservar",
    "reserva",
    "cita",
    "agenda",
    "agendar",
  ],
  location: [
    "location",
    "address",
    "maps",
    "map",
    "google_maps",
    "google maps",
    "ubicacion",
    "ubicación",
    "direccion",
    "dirección",
    "address link",
    "location link",
  ],
  payment: [
    "payment",
    "pay",
    "payment_link",
    "pay_link",
    "pagar",
    "pago",
    "pago_link",
  ],
  website: [
    "website",
    "site",
    "web",
    "pagina",
    "página",
    "pagina web",
    "página web",
  ],
  menu: ["menu", "menú"],
  quote: ["quote", "estimate", "cotizacion", "cotización", "presupuesto"],
};

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeSearchValue(value: unknown): string {
  return clean(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map(normalizeSearchValue).filter(Boolean)));
}

function expandLinkTypes(values?: string[]): string[] {
  const baseValues = values && values.length > 0 ? values : DEFAULT_USEFUL_LINK_TYPES;
  const normalizedBaseValues = unique(baseValues);

  const expanded: string[] = [...normalizedBaseValues];

  for (const value of normalizedBaseValues) {
    for (const aliases of Object.values(USEFUL_LINK_TYPE_ALIASES)) {
      const normalizedAliases = unique(aliases);

      if (normalizedAliases.includes(value)) {
        expanded.push(...normalizedAliases);
      }
    }
  }

  return unique(expanded);
}

function scoreUsefulLink(params: {
  link: UsefulLink;
  requestedTypes: string[];
}): number {
  const tipo = normalizeSearchValue(params.link.tipo);
  const nombre = normalizeSearchValue(params.link.nombre);
  const requestedTypes = params.requestedTypes;

  const exactTipoIndex = requestedTypes.indexOf(tipo);

  if (exactTipoIndex >= 0) {
    return 1000 - exactTipoIndex;
  }

  const exactNombreIndex = requestedTypes.indexOf(nombre);

  if (exactNombreIndex >= 0) {
    return 900 - exactNombreIndex;
  }

  const tipoContainsIndex = requestedTypes.findIndex(
    (requestedType) =>
      tipo.includes(requestedType) || requestedType.includes(tipo)
  );

  if (tipoContainsIndex >= 0) {
    return 800 - tipoContainsIndex;
  }

  const nombreContainsIndex = requestedTypes.findIndex(
    (requestedType) =>
      nombre.includes(requestedType) || requestedType.includes(nombre)
  );

  if (nombreContainsIndex >= 0) {
    return 700 - nombreContainsIndex;
  }

  return 0;
}

export async function tenantHasUsefulLinks(tenantId: string): Promise<boolean> {
  const cleanTenantId = clean(tenantId);

  if (!cleanTenantId) {
    return false;
  }

  const { rows } = await pool.query(
    `
    SELECT 1
    FROM links_utiles
    WHERE tenant_id = $1
      AND NULLIF(TRIM(url), '') IS NOT NULL
    LIMIT 1
    `,
    [cleanTenantId]
  );

  return rows.length > 0;
}

async function findUsefulLinkForTenant(params: {
  tenantId: string;
  linkTypes?: string[];
}): Promise<UsefulLink | null> {
  const requestedTypes = expandLinkTypes(params.linkTypes);

  const { rows } = await pool.query(
    `
    SELECT
      id,
      tipo,
      nombre,
      url
    FROM links_utiles
    WHERE tenant_id = $1
      AND NULLIF(TRIM(url), '') IS NOT NULL
    ORDER BY nombre ASC
    `,
    [params.tenantId]
  );

  const links: UsefulLink[] = rows.map((row) => ({
    id: clean(row.id),
    tipo: clean(row.tipo),
    nombre: clean(row.nombre),
    url: clean(row.url),
  }));

  if (links.length === 0) {
    return null;
  }

  const rankedLinks = links
    .map((link) => ({
      link,
      score: scoreUsefulLink({
        link,
        requestedTypes,
      }),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  if (rankedLinks.length > 0) {
    return rankedLinks[0].link;
  }

  if (!params.linkTypes || params.linkTypes.length === 0) {
    return links[0];
  }

  return null;
}

function buildUsefulLinkSmsBody(params: {
  tenant: TenantSmsConfig;
  link: UsefulLink;
  locale: VoiceLocale;
}): string {
  const businessName = clean(params.tenant.name);
  const linkName = clean(params.link.nombre) || clean(params.link.tipo);
  const url = clean(params.link.url);

  return [
    businessName || null,
    linkName || null,
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
    requestedLinkTypes: params.linkTypes || [],
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