//src/lib/voice/realtime/contacts/voiceContactCrm.ts
import pool from "../../../db";

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeSlot(value: unknown): string {
  return clean(value).toLowerCase();
}

export async function syncVoiceBookingSlotToContact(params: {
  tenantId: string | null;
  callerPhone: string | null;
  targetSlot: string;
  value: string;
  locale?: string | null;
}): Promise<void> {
  const tenantId = clean(params.tenantId);
  const callerPhone = clean(params.callerPhone);
  const targetSlot = normalizeSlot(params.targetSlot);
  const value = clean(params.value);
  const locale = clean(params.locale);

  if (!tenantId || !callerPhone || !targetSlot || !value) {
    return;
  }

  try {
    if (targetSlot === "customer_name") {
      await pool.query(
        `
        UPDATE contactos
        SET
          nombre = CASE
            WHEN nombre IS NULL OR BTRIM(nombre) = '' THEN $3
            ELSE nombre
          END,
          idioma = COALESCE(NULLIF(idioma, ''), NULLIF($4, '')),
          ultima_interaccion_at = NOW(),
          updated_at = NOW()
        WHERE tenant_id = $1
          AND telefono = $2
        `,
        [tenantId, callerPhone, value, locale]
      );

      return;
    }

    if (targetSlot === "customer_email") {
      await pool.query(
        `
        UPDATE contactos
        SET
          email = CASE
            WHEN email IS NULL OR BTRIM(email) = '' THEN $3
            ELSE email
          END,
          idioma = COALESCE(NULLIF(idioma, ''), NULLIF($4, '')),
          ultima_interaccion_at = NOW(),
          updated_at = NOW()
        WHERE tenant_id = $1
          AND telefono = $2
        `,
        [tenantId, callerPhone, value, locale]
      );

      return;
    }

    if (targetSlot === "service") {
      await pool.query(
        `
        UPDATE contactos
        SET
          ultimo_servicio = $3,
          idioma = COALESCE(NULLIF(idioma, ''), NULLIF($4, '')),
          ultima_interaccion_at = NOW(),
          updated_at = NOW()
        WHERE tenant_id = $1
          AND telefono = $2
        `,
        [tenantId, callerPhone, value, locale]
      );
    }
  } catch (error) {
    console.error("[CONTACTOS][VOICE_BOOKING_SLOT_SYNC_ERROR]", {
      tenantId,
      callerPhone,
      targetSlot,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function registerConfirmedVoiceBooking(params: {
  tenantId: string | null;
  callerPhone: string | null;
  appointmentId: string | null;
  scheduledAt: string | Date | null;
  serviceName?: string | null;
}): Promise<void> {
  const tenantId = clean(params.tenantId);
  const callerPhone = clean(params.callerPhone);
  const appointmentId = clean(params.appointmentId);
  const serviceName = clean(params.serviceName) || null;

  if (!tenantId || !callerPhone || !appointmentId) {
    console.warn("[CONTACTOS][BOOKING_REGISTRATION_SKIPPED]", {
      tenantId,
      callerPhone,
      appointmentId,
      reason: "MISSING_REQUIRED_IDENTIFIER",
    });

    return;
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const contactResult = await client.query(
      `
      SELECT id
      FROM contactos
      WHERE tenant_id = $1
        AND telefono = $2
      LIMIT 1
      FOR UPDATE
      `,
      [tenantId, callerPhone]
    );

    const contactId = contactResult.rows[0]?.id;

    if (!contactId) {
      await client.query("ROLLBACK");

      console.warn("[CONTACTOS][BOOKING_REGISTRATION_SKIPPED]", {
        tenantId,
        callerPhone,
        appointmentId,
        reason: "CONTACT_NOT_FOUND",
      });

      return;
    }

    const bookingInsertResult = await client.query(
      `
      INSERT INTO contacto_reservas (
        tenant_id,
        contacto_id,
        appointment_id,
        scheduled_at,
        service_name,
        channel,
        created_at
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        'voice',
        NOW()
      )
      ON CONFLICT (tenant_id, appointment_id)
      DO NOTHING
      RETURNING id
      `,
      [
        tenantId,
        contactId,
        appointmentId,
        params.scheduledAt || null,
        serviceName,
      ]
    );

    const wasNewBooking = bookingInsertResult.rows.length > 0;

    if (wasNewBooking) {
      await client.query(
        `
        UPDATE contactos
        SET
          reservas = COALESCE(reservas, 0) + 1,
          primera_reserva_at = COALESCE(primera_reserva_at, NOW()),
          ultima_reserva_at = NOW(),
          ultima_cita = COALESCE($3::timestamptz, ultima_cita),
          proxima_cita_at = CASE
            WHEN $3::timestamptz IS NULL THEN proxima_cita_at
            WHEN $3::timestamptz >= NOW() THEN $3::timestamptz
            ELSE proxima_cita_at
          END,
          ultimo_servicio = COALESCE(NULLIF($4, ''), ultimo_servicio),
          segmento = 'cliente',
          estado_cliente = CASE
            WHEN COALESCE(reservas, 0) + 1 >= 2 THEN 'recurrente'
            ELSE 'cliente'
          END,
          ultima_interaccion_at = NOW(),
          updated_at = NOW()
        WHERE id = $1
          AND tenant_id = $2
        `,
        [
          contactId,
          tenantId,
          params.scheduledAt || null,
          serviceName || "",
        ]
      );
    }

    await client.query("COMMIT");

    console.log("[CONTACTOS][VOICE_BOOKING_REGISTERED]", {
      tenantId,
      callerPhone,
      appointmentId,
      contactId,
      wasNewBooking,
    });
  } catch (error) {
    await client.query("ROLLBACK");

    console.error("[CONTACTOS][VOICE_BOOKING_REGISTRATION_ERROR]", {
      tenantId,
      callerPhone,
      appointmentId,
      error: error instanceof Error ? error.message : String(error),
    });

    throw error;
  } finally {
    client.release();
  }
}