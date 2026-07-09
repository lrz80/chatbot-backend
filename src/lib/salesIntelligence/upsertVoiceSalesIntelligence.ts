//src/lib/salesIntelligence/upsertVoiceSalesIntelligence.ts
import pool from "../db";

type UpsertVoiceSalesIntelligenceParams = {
  tenantId: string;
  callSid: string | null;
  phone: string | null;
  bookingData?: Record<string, any> | null;
  transcript?: string | null;
  outcome?: string;
};

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function pickFirstNonEmpty(...values: unknown[]): string | null {
  for (const value of values) {
    const cleaned = clean(value);
    if (cleaned) return cleaned;
  }

  return null;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

export async function upsertVoiceSalesIntelligence(
  params: UpsertVoiceSalesIntelligenceParams
): Promise<void> {
  const tenantId = clean(params.tenantId);
  const callSid = clean(params.callSid);
  const phone = clean(params.phone);
  const bookingData = params.bookingData ?? {};
  const transcript = clean(params.transcript);
  const outcome = clean(params.outcome) || "voice_call";

  if (!tenantId) {
    console.warn("[SALES_INTELLIGENCE][VOICE_SKIP_MISSING_TENANT]", {
      callSid: callSid || null,
      phone: phone || null,
    });
    return;
  }

  if (!callSid && !phone) {
    console.warn("[SALES_INTELLIGENCE][VOICE_SKIP_MISSING_CONTACT]", {
      tenantId,
    });
    return;
  }

  const customerName = pickFirstNonEmpty(
    bookingData.customer_name,
    bookingData.name,
    bookingData.full_name,
    bookingData.client_name
  );

  const serviceName = pickFirstNonEmpty(
    bookingData.service,
    bookingData.requested_service,
    bookingData.service_name,
    bookingData.appointment_service
  );

  const datetime = pickFirstNonEmpty(
    bookingData.datetime_display,
    bookingData.datetime,
    bookingData.datetime_iso,
    bookingData.requested_datetime,
    bookingData.appointment_datetime,
    bookingData.start_at,
    bookingData.startAt
  );

  const mensaje = safeJson({
    source: "voice_realtime",
    outcome,
    callSid: callSid || null,
    phone: phone || null,
    customerName,
    serviceName,
    datetime,
    transcript: transcript || null,
    bookingData,
  });

  const intencion =
    outcome.includes("confirmed") || outcome.includes("booked")
      ? "booking_confirmed"
      : "voice_call";

  const nivelInteres =
    outcome.includes("confirmed") || outcome.includes("booked")
      ? 5
      : outcome.includes("requires") ||
          outcome.includes("failed") ||
          outcome.includes("unavailable")
        ? 4
        : 1;

  const messageId = callSid || `voice:${tenantId}:${phone}`;

  await pool.query(
    `
    INSERT INTO sales_intelligence (
      tenant_id,
      contacto,
      canal,
      mensaje,
      intencion,
      nivel_interes,
      fecha,
      message_id
    )
    VALUES (
      $1,
      $2,
      $3,
      $4,
      $5,
      $6,
      NOW(),
      $7
    )
    ON CONFLICT (tenant_id, message_id)
    WHERE message_id IS NOT NULL
    DO UPDATE SET
      contacto = COALESCE(EXCLUDED.contacto, sales_intelligence.contacto),
      canal = EXCLUDED.canal,
      mensaje = EXCLUDED.mensaje,
      intencion = EXCLUDED.intencion,
      nivel_interes = GREATEST(
        COALESCE(sales_intelligence.nivel_interes, 0),
        COALESCE(EXCLUDED.nivel_interes, 0)
      ),
      fecha = NOW()
    `,
    [
      tenantId,
      phone || null,
      "voice",
      mensaje,
      intencion,
      nivelInteres,
      messageId,
    ]
  );

  console.log("[SALES_INTELLIGENCE][VOICE_UPSERT_OK]", {
    tenantId,
    callSid: callSid || null,
    phone: phone || null,
    outcome,
    intencion,
    nivelInteres,
  });
}