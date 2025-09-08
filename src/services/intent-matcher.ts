import pool from "../lib/db";
import { normalize, bestPatternScore } from "../utils/text-match";

type IntencionRow = {
  id: number;
  canal: string;
  nombre: string;
  ejemplos: string[];
  respuesta: string;
  idioma: string | null;
  prioridad: number;
  activo: boolean;
};

function canalesDe(canal: string) {
  const c = (canal || "whatsapp").toLowerCase();
  return c === "meta" ? ["meta", "facebook", "instagram"] : [c];
}

/**
 * Busca la mejor intención por similitud de patrones.
 * @param umbral: configurable por env INTENT_MATCH_THRESHOLD (default 0.55)
 * @param filtrarPorIdioma: si true, solo considera filas con idioma==idiomaDetectado (cuando la fila tiene idioma definido)
 */
export async function buscarRespuestaPorIntencion(opts: {
  tenant_id: string;
  canal: "whatsapp" | "facebook" | "instagram" | "meta" | "voz";
  mensajeUsuario: string;
  idiomaDetectado?: string | null;
  umbral?: number;
  filtrarPorIdioma?: boolean;
}) {
  const {
    tenant_id,
    canal,
    mensajeUsuario,
    idiomaDetectado = null,
    umbral = Number(process.env.INTENT_MATCH_THRESHOLD ?? 0.55),
    filtrarPorIdioma = true
  } = opts;

  const canales = canalesDe(canal);

  // Traemos activas ordenadas por prioridad asc
  const { rows } = await pool.query<IntencionRow>(
    `SELECT id, canal, nombre, ejemplos, respuesta, idioma, prioridad, activo
       FROM intenciones
      WHERE tenant_id = $1
        AND canal = ANY($2)
        AND activo = TRUE
      ORDER BY prioridad ASC, id ASC`,
    [tenant_id, canales]
  );

  const msg = normalize(mensajeUsuario);
  let best:
    | { row: IntencionRow; score: number; matchedPattern: string }
    | null = null;

  for (const row of rows) {
    if (filtrarPorIdioma && row.idioma && idiomaDetectado && row.idioma !== idiomaDetectado) {
      continue; // respeta idioma si la fila lo define
    }
    const match = bestPatternScore(msg, row.ejemplos || [], umbral);
    if (match) {
      if (!best || match.score > best.score) {
        best = { row, score: match.score, matchedPattern: match.pattern };
      }
    }
  }

  if (!best) return null;

  return {
    id: best.row.id,
    canal: best.row.canal,
    intent: best.row.nombre,
    respuesta: best.row.respuesta,
    prioridad: best.row.prioridad,
    score: Number(best.score.toFixed(3)),
    matchedPattern: best.matchedPattern,
  };
}
