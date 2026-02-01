// src/lib/appointments/booking/db.ts
import pool from "../../db";
import type { HoursByWeekday } from "./types";

type DayHours = { start: string; end: string }; // local helper

export async function getAppointmentSettings(tenantId: string) {
  // 1) Asegura fila (si no existe)
  await pool.query(
    `
    INSERT INTO appointment_settings (
      tenant_id,
      default_duration_min,
      buffer_min,
      timezone,
      enabled,
      min_lead_minutes
    )
    VALUES ($1, 30, 10, 'America/New_York', true, 60)
    ON CONFLICT (tenant_id) DO NOTHING
    `,
    [tenantId]
  );

  // 2) Lee settings
  const { rows } = await pool.query(
    `
    SELECT
      tenant_id,
      default_duration_min,
      buffer_min,
      timezone,
      enabled,
      min_lead_minutes
    FROM appointment_settings
    WHERE tenant_id = $1
    LIMIT 1
    `,
    [tenantId]
  );

  const r = rows[0] || {};
  return {
    durationMin: Number(r.default_duration_min ?? 30),
    bufferMin: Number(r.buffer_min ?? 10),
    timeZone: String(r.timezone ?? "America/New_York"),
    enabled: r.enabled !== false,
    minLeadMinutes: Number(r.min_lead_minutes ?? 60),
  };
}

export async function updateAppointmentSettings(
  tenantId: string,
  patch: Partial<{
    durationMin: number;
    bufferMin: number;
    timeZone: string;
    enabled: boolean;
    minLeadMinutes: number;
  }>
) {
  // Lee current (y asegura fila)
  const current = await getAppointmentSettings(tenantId);

  // Merge (solo lo que venga definido)
  const merged = {
    ...current,
    ...Object.fromEntries(Object.entries(patch).filter(([_, v]) => v !== undefined)),
  };

  await pool.query(
    `
    UPDATE appointment_settings
    SET
      default_duration_min = $2,
      buffer_min           = $3,
      timezone             = $4,
      enabled              = $5,
      min_lead_minutes     = $6
    WHERE tenant_id = $1
    `,
    [
      tenantId,
      Number(merged.durationMin),
      Number(merged.bufferMin),
      String(merged.timeZone),
      merged.enabled !== false,
      Number(merged.minLeadMinutes),
    ]
  );

  return merged;
}

export async function getBusinessHours(tenantId: string): Promise<HoursByWeekday | null> {
  try {
    const { rows } = await pool.query(
      `SELECT horario_atencion FROM tenants WHERE id = $1 LIMIT 1`,
      [tenantId]
    );
    const raw = rows[0]?.horario_atencion;
    if (!raw) return null;

    // BACKUP: si viene como texto "09:00-17:00", conviértelo a JSON por días
    if (typeof raw === "string") {
      const s = raw.trim();
      const m = s.match(/^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/);
      if (m) {
        const start = m[1];
        const end = m[2];

        return {
          mon: { start, end },
          tue: { start, end },
          wed: { start, end },
          thu: { start, end },
          fri: { start, end },
          sat: null,
          sun: null,
        };
      }
    }

    const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!obj || typeof obj !== "object") return null;

    const mapKey = (k: string) => {
      const x = String(k || "").toLowerCase().trim();
      if (["mon", "monday", "lunes"].includes(x)) return "mon";
      if (["tue", "tues", "tuesday", "martes"].includes(x)) return "tue";
      if (["wed", "weds", "wednesday", "miercoles", "miércoles"].includes(x)) return "wed";
      if (["thu", "thur", "thurs", "thursday", "jueves"].includes(x)) return "thu";
      if (["fri", "friday", "viernes"].includes(x)) return "fri";
      if (["sat", "saturday", "sabado", "sábado"].includes(x)) return "sat";
      if (["sun", "sunday", "domingo"].includes(x)) return "sun";
      return null;
    };

    const normalizeDay = (v: any): DayHours | null => {
      if (!v) return null;

      if (typeof v === "object" && (v.start || v.end)) {
        const start = String(v.start || "").trim();
        const end = String(v.end || "").trim();
        return start && end ? { start, end } : null;
      }

      if (typeof v === "object" && (v.open || v.close)) {
        const start = String(v.open || "").trim();
        const end = String(v.close || "").trim();
        return start && end ? { start, end } : null;
      }

      if (Array.isArray(v) && v.length >= 2) {
        const start = String(v[0] || "").trim();
        const end = String(v[1] || "").trim();
        return start && end ? { start, end } : null;
      }

      return null;
    };

    const out: HoursByWeekday = {};

    for (const [k, v] of Object.entries(obj as Record<string, any>)) {
      const wk = mapKey(k);
      if (!wk) continue;
      (out as any)[wk] = normalizeDay(v);
    }

    const anyDay = Object.values(out).some(Boolean);
    return anyDay ? out : null;
  } catch {
    return null;
  }
}

export async function isGoogleConnected(tenantId: string): Promise<boolean> {
  try {
    const { rows } = await pool.query(
      `
      SELECT 1
      FROM calendar_integrations
      WHERE tenant_id = $1
        AND status = 'connected'
      LIMIT 1
      `,
      [tenantId]
    );
    return rows.length > 0;
  } catch (e: any) {
    console.log("❌ isGoogleConnected error:", e.message);
    return false;
  }
}

export async function loadBookingTerms(tenantId: string): Promise<string[]> {
  try {
    const { rows } = await pool.query(
      `SELECT hints FROM tenants WHERE id = $1 LIMIT 1`,
      [tenantId]
    );
    const hints = rows[0]?.hints;
    const obj = typeof hints === "string" ? JSON.parse(hints) : (hints || {});
    const terms = Array.isArray(obj?.booking_terms) ? obj.booking_terms : null;
    if (terms && terms.length) {
      return terms
        .map((t: any) => String(t).toLowerCase().trim())
        .filter(Boolean);
    }
  } catch {}

  return [
    "cita", "consulta", "reservar", "reserva", "turno", "agendar",
    "appointment", "book", "booking", "schedule",
    "agedar", "agendar cita", "agendarme", "agenda", "agend",
    "bok", "scheduel",
  ];
}

export async function upsertClienteBookingData(opts: {
  tenantId: string;
  canal: string;
  contacto?: string; // ✅ ahora opcional
  nombre?: string | null;
  email?: string | null;
  telefono?: string | null;
}) {
  const { tenantId, canal, nombre, email, telefono } = opts;

  // ✅ contactoFinal: usamos lo mejor disponible
  const contactoFinal =
    (opts.contacto && String(opts.contacto).trim()) ||
    (telefono && String(telefono).trim()) ||
    (email && String(email).trim()) ||
    "";

  // ✅ Si no tenemos ningún identificador, no insertamos (evita basura / conflictos raros)
  if (!contactoFinal) {
    console.warn("⚠️ upsertClienteBookingData: missing contacto/telefono/email");
    return;
  }

  try {
    await pool.query(
      `
      INSERT INTO clientes (tenant_id, canal, contacto, nombre, email, telefono, updated_at, created_at)
      VALUES ($1,$2,$3,$4,$5,$6, NOW(), NOW())
      ON CONFLICT (tenant_id, canal, contacto)
      DO UPDATE SET
        nombre   = COALESCE(EXCLUDED.nombre,   clientes.nombre),
        email    = COALESCE(EXCLUDED.email,    clientes.email),
        telefono = COALESCE(EXCLUDED.telefono, clientes.telefono),
        updated_at = NOW()
      `,
      [tenantId, canal, contactoFinal, nombre || null, email || null, telefono || null]
    );
  } catch (e: any) {
    console.warn("⚠️ upsertClienteBookingData failed:", e?.message);
  }
}

export async function markAppointmentConfirmed(opts: {
  apptId: string;
  google_event_id: string | null;
  google_event_link: string | null;
}) {
  const { apptId, google_event_id, google_event_link } = opts;
  await pool.query(
    `
    UPDATE appointments
       SET status='confirmed',
           google_event_id=$2,
           google_event_link=$3
     WHERE id=$1
    `,
    [apptId, google_event_id, google_event_link]
  );
}

export async function markAppointmentFailed(opts: {
  apptId: string;
  error_reason: string;
}) {
  const { apptId, error_reason } = opts;
  await pool.query(
    `
    UPDATE appointments
       SET status='failed',
           error_reason=$2
     WHERE id=$1
    `,
    [apptId, error_reason]
  );
}

export async function createPendingAppointmentOrGetExisting(opts: {
  tenantId: string;
  channel: string;
  customer_name: string;
  customer_phone?: string;
  customer_email?: string;
  start_time: string;
  end_time: string;
}) {
  const {
    tenantId, channel, customer_name, customer_phone, customer_email, start_time, end_time,
  } = opts;

  const { rows } = await pool.query(
    `
    INSERT INTO appointments (
      tenant_id, service_id, channel, customer_name, customer_phone, customer_email,
      start_time, end_time, status, google_event_id, google_event_link
    )
    VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, 'pending', NULL, NULL)
    ON CONFLICT (tenant_id, channel, customer_phone, start_time)
    DO UPDATE SET
      customer_name = COALESCE(EXCLUDED.customer_name, appointments.customer_name),
      customer_email = COALESCE(EXCLUDED.customer_email, appointments.customer_email),
      end_time = EXCLUDED.end_time
    RETURNING id, status, google_event_link, google_event_id
    `,
    [
      tenantId,
      channel,
      customer_name,
      customer_phone || null,
      customer_email || null,
      start_time,
      end_time,
    ]
  );

  return rows[0] || null;
}
