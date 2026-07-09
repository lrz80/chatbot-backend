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

  if (!tenantId || !callerPhone || !targetSlot || !value) return;

  try {
    if (targetSlot === "customer_name") {
      await pool.query(
        `
        UPDATE contactos
        SET
          nombre = CASE
            WHEN nombre IS NULL OR nombre = '' THEN $3
            ELSE nombre
          END,
          idioma = COALESCE(NULLIF(idioma, ''), NULLIF($4, '')),
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
            WHEN email IS NULL OR email = '' THEN $3
            ELSE email
          END,
          idioma = COALESCE(NULLIF(idioma, ''), NULLIF($4, '')),
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