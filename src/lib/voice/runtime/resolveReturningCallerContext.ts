//src/lib/voice/runtime/resolveReturningCallerContext.ts
import pool from "../../db";

export type ReturningCallerContext = {
  contactId: number;
  name: string;
  phone: string;
  language: string | null;
  lastService: string;
  reservations: number;
};

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizePhoneToE164(value: unknown): string | null {
  const raw = clean(value);

  if (!raw) {
    return null;
  }

  const digits = raw.replace(/\D/g, "");

  if (digits.length === 10) {
    return `+1${digits}`;
  }

  if (digits.length === 11 && digits.startsWith("1")) {
    return `+${digits}`;
  }

  if (digits.length >= 11 && digits.length <= 15) {
    return `+${digits}`;
  }

  return null;
}

function isValidContactName(value: unknown): boolean {
  const name = clean(value);

  if (!name) {
    return false;
  }

  const normalized = name.toLowerCase();

  return (
    normalized !== "sin nombre" &&
    normalized !== "unknown" &&
    normalized !== "cliente" &&
    normalized !== "customer"
  );
}

export async function resolveReturningCallerContext(params: {
  tenantId: string;
  callerPhone: string | null;
}): Promise<ReturningCallerContext | null> {
  const tenantId = clean(params.tenantId);
  const callerPhone = normalizePhoneToE164(params.callerPhone);

  if (!tenantId || !callerPhone) {
    return null;
  }

  try {
    const result = await pool.query(
      `
      SELECT
        c.id,
        c.nombre,
        c.telefono,
        c.idioma,
        COALESCE(c.reservas, 0)::int AS reservas,
        c.ultimo_servicio
      FROM contactos c
      WHERE c.tenant_id = $1
        AND c.telefono = $2
        AND COALESCE(c.reservas, 0) > 0
        AND NULLIF(TRIM(c.nombre), '') IS NOT NULL
        AND NULLIF(TRIM(c.ultimo_servicio), '') IS NOT NULL
      LIMIT 1
      `,
      [tenantId, callerPhone]
    );

    const row = result.rows[0];

    if (!row) {
      return null;
    }

    const name = clean(row.nombre);
    const lastService = clean(row.ultimo_servicio);
    const reservations = Number(row.reservas || 0);

    if (!isValidContactName(name)) {
      return null;
    }

    if (!lastService || reservations <= 0) {
      return null;
    }

    return {
      contactId: Number(row.id),
      name,
      phone: clean(row.telefono),
      language: clean(row.idioma) || null,
      lastService,
      reservations,
    };
  } catch (error) {
    /**
     * Una falla del CRM nunca debe impedir que entre la llamada.
     * Si la consulta falla, se usa la bienvenida normal.
     */
    console.error("[VOICE_REALTIME][RETURNING_CALLER_CONTEXT_ERROR]", {
      tenantId,
      callerPhone,
      error:
        error instanceof Error
          ? error.message
          : String(error),
    });

    return null;
  }
}