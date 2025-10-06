import pool from "../lib/db";

/** Respuesta estándar del util */
export type FaqHit = {
  id: string;
  intencion: string;
  respuesta: string;
  canal: string | null;
};

/** Variantes mínimas “seguras” por intención (válido para todos los negocios) */
const BASE_VARIANTS: Record<string, string[]> = {
  horario: [
    "horario", "horarios", "hours", "hour", "schedule", "schedules", "time", "times"
  ],
  precio: [
    "precio", "precios", "price", "prices", "cost", "costs", "fee", "fees", "tarifa", "tarifas"
  ],
  ubicacion: [
    "ubicacion", "ubicación", "location", "address", "direccion", "dirección"
  ],
  reservar: [
    "reservar", "reserva", "agendar", "agenda", "book", "booking", "schedule_class"
  ],
  comprar:  ["comprar", "compra", "buy", "purchase"],
  confirmar:["confirmar", "confirmación", "confirm"],
  interes_clases: ["interes_clases", "info_clases", "clases", "clase", "services", "servicios"],
  clases_online: ["clases_online", "online_classes", "virtual", "virtuales"],
};

/** Normaliza string para comparaciones SQL */
const norm = (s: string) => s.toLowerCase().trim();

/**
 * Busca una FAQ por intención para un tenant/canal con:
 * 1) match exacto (LOWER/TRIM) usando variantes seguras
 * 2) fallback sin canal (si fue guardada con canal NULL u otro)
 * 3) (opcional) fallback fuzzy con pg_trgm si está disponible
 *
 * @param tenantId UUID del negocio
 * @param canal    ej. 'whatsapp' | 'meta' | ...
 * @param intentCanonica ej. 'horario' | 'precio' ...
 */
export async function getFaqByIntent(
  tenantId: string,
  canal: string,
  intentCanonica: string
): Promise<FaqHit | null> {
  const canon = norm(intentCanonica);
  const keys = (BASE_VARIANTS[canon] || [canon]).map(norm);

  // 1) Match por tenant + canal + intención (varias variantes)
  let { rows } = await pool.query(
    `SELECT id, intencion, respuesta, canal
       FROM faqs
      WHERE tenant_id = $1
        AND LOWER(TRIM(canal)) = LOWER(TRIM($2))
        AND LOWER(TRIM(intencion)) = ANY($3)
      ORDER BY CASE WHEN LOWER(TRIM(intencion)) = $4 THEN 0 ELSE 1 END
      LIMIT 1`,
    [tenantId, canal, keys, canon]
  );

  // 2) Fallback SIN canal (por si la fila tiene canal NULL u otro valor)
  if (rows.length === 0) {
    const r2 = await pool.query(
      `SELECT id, intencion, respuesta, canal
         FROM faqs
        WHERE tenant_id = $1
          AND LOWER(TRIM(intencion)) = ANY($2)
        ORDER BY CASE WHEN LOWER(TRIM(intencion)) = $3 THEN 0 ELSE 1 END
        LIMIT 1`,
      [tenantId, keys, canon]
    );
    rows = r2.rows;
  }

  if (rows.length > 0) {
    const r = rows[0];
    return { id: r.id, intencion: r.intencion, respuesta: r.respuesta, canal: r.canal };
  }

  // 3) (Opcional) Fuzzy con pg_trgm si existe la extensión e índices
  //    – Seguro para multitenant; sólo dentro del mismo tenant.
  //    – Si no tienes pg_trgm, puedes comentar este bloque.
  try {
    const r3 = await pool.query(
      `SELECT id, intencion, respuesta, canal
         FROM faqs
        WHERE tenant_id = $1
        ORDER BY GREATEST(
                 similarity(LOWER(TRIM(intencion)), $2),
                 similarity(LOWER(TRIM(coalesce(canal,''))), LOWER(TRIM($3))) * 0.15
               ) DESC
        LIMIT 1`,
      [tenantId, canon, canal]
    );
    const hit = r3.rows?.[0];
    // umbral conservador para no traer cosas raras (ajústalo si hace falta)
    if (hit) {
      // una comprobación rápida de sanidad: que la intención sea “parecida”
      const ok =
        norm(hit.intencion) === canon ||
        keys.some(k => norm(hit.intencion) === k) ||
        norm(hit.intencion).includes(canon) ||
        canon.includes(norm(hit.intencion));
      if (ok) {
        return { id: hit.id, intencion: hit.intencion, respuesta: hit.respuesta, canal: hit.canal };
      }
    }
  } catch (e) {
    // si no existe pg_trgm/índices, simplemente ignoramos
  }

  return null;
}
