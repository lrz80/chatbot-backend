//src/lib/whatsapp/humanTakeover.ts
import pool from "../db";

const DEFAULT_TAKEOVER_MINUTES = 15;

function getTakeoverMinutes(): number {
  const raw = Number(
    process.env.WHATSAPP_HUMAN_TAKEOVER_MINUTES ||
      DEFAULT_TAKEOVER_MINUTES
  );

  if (!Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_TAKEOVER_MINUTES;
  }

  return Math.min(Math.floor(raw), 1440);
}

export function normalizeWhatsAppContactKey(
  value: unknown
): string {
  return String(value || "")
    .trim()
    .replace(/^whatsapp:/i, "")
    .replace(/^\+/, "");
}

export async function activateWhatsAppHumanTakeover(params: {
  phoneNumberId: string;
  contactKey: string;
  messageId?: string | null;
}) {
  const phoneNumberId = String(
    params.phoneNumberId || ""
  ).trim();

  const contactKey = normalizeWhatsAppContactKey(
    params.contactKey
  );

  if (!phoneNumberId || !contactKey) {
    return {
      ok: false as const,
      reason: "MISSING_IDENTITY",
    };
  }

  const minutes = getTakeoverMinutes();

  const result = await pool.query(
    `
    INSERT INTO whatsapp_human_takeovers (
      tenant_id,
      contact_key,
      source,
      last_human_message_at,
      expires_at,
      last_message_id,
      created_at,
      updated_at
    )
    SELECT
      t.id,
      $2,
      'whatsapp_business_app',
      NOW(),
      NOW() + ($3 * INTERVAL '1 minute'),
      $4,
      NOW(),
      NOW()
    FROM tenants t
    WHERE t.whatsapp_phone_number_id = $1
      AND t.whatsapp_mode = 'cloudapi'
      AND t.whatsapp_connected = TRUE

    ON CONFLICT (tenant_id, contact_key)
    DO UPDATE SET
      source = 'whatsapp_business_app',
      last_human_message_at = NOW(),
      expires_at =
        NOW() + ($3 * INTERVAL '1 minute'),
      last_message_id = EXCLUDED.last_message_id,
      updated_at = NOW()

    RETURNING
      tenant_id,
      contact_key,
      expires_at;
    `,
    [
      phoneNumberId,
      contactKey,
      minutes,
      params.messageId || null,
    ]
  );

  if (!result.rowCount) {
    return {
      ok: false as const,
      reason: "TENANT_NOT_FOUND",
    };
  }

  return {
    ok: true as const,
    minutes,
    tenantId: result.rows[0].tenant_id,
    contactKey: result.rows[0].contact_key,
    expiresAt: result.rows[0].expires_at,
  };
}

export async function isWhatsAppHumanTakeoverActive(
  tenantId: string,
  contactKeyRaw: string
): Promise<{
  active: boolean;
  expiresAt: Date | null;
}> {
  const contactKey =
    normalizeWhatsAppContactKey(contactKeyRaw);

  if (!tenantId || !contactKey) {
    return {
      active: false,
      expiresAt: null,
    };
  }

  const result = await pool.query(
    `
    SELECT expires_at
    FROM whatsapp_human_takeovers
    WHERE tenant_id = $1
      AND contact_key = $2
      AND expires_at > NOW()
    LIMIT 1
    `,
    [tenantId, contactKey]
  );

  if (!result.rowCount) {
    return {
      active: false,
      expiresAt: null,
    };
  }

  return {
    active: true,
    expiresAt: result.rows[0].expires_at,
  };
}

export async function releaseWhatsAppHumanTakeover(
  tenantId: string,
  contactKeyRaw: string
): Promise<void> {
  const contactKey =
    normalizeWhatsAppContactKey(contactKeyRaw);

  if (!tenantId || !contactKey) {
    return;
  }

  await pool.query(
    `
    DELETE FROM whatsapp_human_takeovers
    WHERE tenant_id = $1
      AND contact_key = $2
    `,
    [tenantId, contactKey]
  );
}