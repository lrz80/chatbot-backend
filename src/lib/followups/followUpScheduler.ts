// src/lib/followups/followUpScheduler.ts
import pool from "../db";

export type Canal = "whatsapp" | "facebook" | "instagram";

export type TenantLike = {
  id: string;
  name?: string;
  membresia_activa?: boolean;
};

export type ScheduleFollowUpArgs = {
  tenant: TenantLike;
  canal: Canal | string;
  contactoNorm: string;
  idiomaDestino: "es" | "en"; // se mantiene por compatibilidad; el worker traduce si hace falta
  intFinal: string | null;
  nivel: number; // tu escala actual parece 1..5
  userText: string;
};

function isSupportedCanal(c: string): c is Canal {
  const x = (c || "").toLowerCase().trim();
  return x === "whatsapp" || x === "facebook" || x === "instagram";
}

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(n, b));
}

/**
 * Bucket de nivel (asumiendo tu escala actual 1..5):
 * - 1..2 => bajo
 * - 3    => medio
 * - 4..5 => alto
 */
function bucketByNivel_1a5(nivel: number): "bajo" | "medio" | "alto" {
  const n = Number(nivel || 0);
  if (n <= 2) return "bajo";
  if (n === 3) return "medio";
  return "alto";
}

/**
 * Reglas mínimas de elegibilidad:
 * - requiere intFinal (si no hay intención, no seguimos)
 * - requiere nivel >= 2 (si quieres ser más agresivo, baja a >=1)
 */
function shouldSchedule(intFinal: string | null, nivel: number) {
  if (!intFinal) return false;
  const n = Number(nivel || 0);
  if (n < 2) return false;
  return true;
}

/**
 * Lee settings desde follow_up_settings.
 * Nota: asumimos que YA agregaste columnas:
 * - mensaje_nivel_bajo
 * - mensaje_nivel_medio
 * - mensaje_nivel_alto
 *
 * Si aún no existen, este código igual compila, pero el SELECT fallará.
 * Asegúrate de ejecutar el ALTER TABLE correspondiente.
 */
async function getFollowUpSettings(tenantId: string) {
  const { rows } = await pool.query(
    `
    SELECT
      minutos_espera,
      mensaje_nivel_bajo,
      mensaje_nivel_medio,
      mensaje_nivel_alto,
      -- fallback legacy (por si lo sigues usando en algunos tenants)
      mensaje_general
    FROM follow_up_settings
    WHERE tenant_id = $1
    LIMIT 1
    `,
    [tenantId]
  );

  const r = rows[0] || {};

  // UI: 1..23 horas -> DB guarda minutos. Clampeamos 60..1380.
  const minutos = clamp(Number(r.minutos_espera ?? 60), 60, 23 * 60);

  return {
    minutos_espera: minutos,
    mensaje_nivel_bajo: String(r.mensaje_nivel_bajo || "").trim(),
    mensaje_nivel_medio: String(r.mensaje_nivel_medio || "").trim(),
    mensaje_nivel_alto: String(r.mensaje_nivel_alto || "").trim(),
    // legacy fallback
    mensaje_general: String(r.mensaje_general || "").trim(),
  };
}

function chooseByNivel(settings: any, nivel: number) {
  const b = bucketByNivel_1a5(nivel);

  if (b === "alto" && settings.mensaje_nivel_alto) return settings.mensaje_nivel_alto;
  if (b === "medio" && settings.mensaje_nivel_medio) return settings.mensaje_nivel_medio;
  if (settings.mensaje_nivel_bajo) return settings.mensaje_nivel_bajo;

  // fallback final (si todo está vacío)
  return (
    settings.mensaje_general ||
    "Solo paso a confirmar si aún necesitas ayuda. Responde este mensaje y te atiendo de inmediato."
  );
}

/**
 * Inserta un solo follow-up pendiente.
 * Recomendación DB (para evitar duplicados):
 *   CREATE UNIQUE INDEX uq_mprog_one_pending
 *   ON mensajes_programados (tenant_id, canal, contacto)
 *   WHERE enviado = false;
 *
 * Con eso, si ya existe pending, hacemos UPDATE.
 */
async function insertOrUpdatePending(params: {
  tenantId: string;
  canal: Canal;
  contacto: string;
  contenido: string;
  delayMin: number;
}) {
  const { tenantId, canal, contacto, contenido, delayMin } = params;

  try {
    await pool.query(
      `
      INSERT INTO mensajes_programados
        (tenant_id, canal, contacto, contenido, fecha_envio, enviado)
      VALUES
        ($1, $2, $3, $4, NOW() + ($5 || ' minutes')::interval, false)
      `,
      [tenantId, canal, contacto, contenido, String(delayMin)]
    );
  } catch (e: any) {
    // 23505 = unique_violation
    if (String(e?.code) === "23505") {
      await pool.query(
        `
        UPDATE mensajes_programados
           SET contenido = $4,
               fecha_envio = NOW() + ($5 || ' minutes')::interval
         WHERE tenant_id = $1
           AND canal = $2
           AND contacto = $3
           AND enviado = false
        `,
        [tenantId, canal, contacto, contenido, String(delayMin)]
      );
    } else {
      throw e;
    }
  }
}

/**
 * ✅ FUNCIÓN PRINCIPAL
 */
export async function scheduleFollowUpIfEligible(
  args: ScheduleFollowUpArgs
): Promise<void> {
  const { tenant, canal, contactoNorm, intFinal, nivel, userText } = args;

  // 1) Canal soportado
  if (!isSupportedCanal(String(canal))) return;
  const canalOk = String(canal).toLowerCase().trim() as Canal;

  // 2) Contacto válido
  if (!contactoNorm || contactoNorm.trim().length < 5) return;

  // 3) Membresía (si quieres permitir followups sin membresía, elimina esto)
  if (tenant?.membresia_activa === false) return;

  // 4) Elegibilidad mínima por intención/nivel
  if (!shouldSchedule(intFinal, nivel)) return;

  // 5) Settings (delay 1..23h en minutos) + mensajes por nivel
  const settings = await getFollowUpSettings(tenant.id);

  // 6) Contenido por nivel (bajo/medio/alto)
  const contenido = chooseByNivel(settings, nivel);

  // 7) Jitter pequeño (±10%) para no quedar demasiado "robótico"
  const jitter = Math.floor(settings.minutos_espera * (Math.random() * 0.2 - 0.1));
  const delayMin = Math.max(5, settings.minutos_espera + jitter);

  // 8) Insert/Update pending (un solo follow-up por contacto/canal)
  await insertOrUpdatePending({
    tenantId: tenant.id,
    canal: canalOk,
    contacto: contactoNorm.trim(),
    contenido,
    delayMin,
  });

  // Nota: no hacemos nada con idiomaDestino aquí porque tu worker ya
  // detecta idioma del cliente y traduce el contenido si hace falta.
  void userText; // silencia unused si TS strict y no lo usas aún
}
