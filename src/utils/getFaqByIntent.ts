import pool from "../lib/db";

export type FaqHit = {
  id: string;
  intencion: string;
  respuesta: string;
  canal: string | null;
};

const BASE_VARIANTS: Record<string, string[]> = {
  horario: ["horario","horarios","hours","hour","schedule","schedules","time","times"],
  precio: ["precio","precios","price","prices","cost","costs","fee","fees","tarifa","tarifas"],
  ubicacion: ["ubicacion","ubicación","location","address","direccion","dirección"],
  reservar: ["reservar","reserva","agendar","agenda","book","booking","schedule_class"],
  comprar: ["comprar","compra","buy","purchase"],
  confirmar: ["confirmar","confirmación","confirm"],
  interes_clases: ["interes_clases","info_clases","clases","clase","services","servicios"],
  clases_online: ["clases_online","online_classes","virtual","virtuales"],
};

const norm = (s: string) => s.toLowerCase().trim();

export async function getFaqByIntent(
  tenantId: string,
  canal: string,
  intentCanonica: string
): Promise<FaqHit | null> {
  const canon = norm(intentCanonica);
  const keys = (BASE_VARIANTS[canon] || [canon]).map(norm);

  // 1) Match exacto por tenant + canal + intención (variantes)
  //  - COALESCE(canal,'') para tolerar NULLs
  //  - $2::text y $3::text[] para evitar 'unknown' en PG
  let { rows } = await pool.query(
    `
    SELECT id, intencion, respuesta, canal
      FROM faqs
     WHERE tenant_id = $1
       AND LOWER(TRIM(COALESCE(canal, ''))) = LOWER(TRIM($2::text))
       AND LOWER(TRIM(intencion)) = ANY($3::text[])
     ORDER BY CASE WHEN LOWER(TRIM(intencion)) = $4::text THEN 0 ELSE 1 END
     LIMIT 1
    `,
    [tenantId, canal, keys, canon]
  );

  // 2) Fallback SIN canal
  if (rows.length === 0) {
    const r2 = await pool.query(
      `
      SELECT id, intencion, respuesta, canal
        FROM faqs
       WHERE tenant_id = $1
         AND LOWER(TRIM(intencion)) = ANY($2::text[])
       ORDER BY CASE WHEN LOWER(TRIM(intencion)) = $3::text THEN 0 ELSE 1 END
       LIMIT 1
      `,
      [tenantId, keys, canon]
    );
    rows = r2.rows;
  }

  if (rows.length > 0) {
    const r = rows[0];
    return { id: r.id, intencion: r.intencion, respuesta: r.respuesta, canal: r.canal };
  }

  // 3) Fuzzy con pg_trgm (opcional)
  //  - Castea $2/$3 a text
  //  - COALESCE(canal,'') para NULLs
  try {
    const r3 = await pool.query(
      `
      SELECT id, intencion, respuesta, canal
        FROM faqs
       WHERE tenant_id = $1
       ORDER BY GREATEST(
                similarity(LOWER(TRIM(intencion)), LOWER(TRIM($2::text))),
                similarity(LOWER(TRIM(COALESCE(canal, ''))), LOWER(TRIM($3::text))) * 0.15
              ) DESC
       LIMIT 1
      `,
      [tenantId, canon, canal]
    );
    const hit = r3.rows?.[0];

    if (hit) {
      const h = norm(hit.intencion || "");
      const ok =
        h === canon ||
        (BASE_VARIANTS[canon] || [canon]).some(v => norm(v) === h) ||
        h.includes(canon) ||
        canon.includes(h);

      if (ok) {
        return { id: hit.id, intencion: hit.intencion, respuesta: hit.respuesta, canal: hit.canal };
      }
    }
  } catch {
    // sin pg_trgm o sin permisos → ignora el fuzzy
  }

  return null;
}
