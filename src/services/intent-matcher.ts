// 📁 backend/src/services/intent-matcher.ts
import pool from "../lib/db";
import { normalize, bestPatternScore } from "../utils/text-match";

type IntencionRow = {
  id: number;
  canal: string;
  nombre: string;
  ejemplos: any;             // puede llegar como text[] o como string '{a,"b c"}'
  respuesta: string;
  idioma: string | null;
  prioridad: number;
  activo: boolean;
};

function canalesDe(canal: string) {
  const c = (canal || "whatsapp").toLowerCase();
  return c === "meta" ? ["meta", "facebook", "instagram"] : [c];
}

// Colapsa letras repetidas: "preciios" -> "precios"
function squashRepeats(s: string) {
  return (s || "").replace(/([a-záéíóúüñ])\1+/gi, "$1");
}

// Convierte '{a,"b c",d}' o arrays raros a string[]
function toArray(x: any): string[] {
  if (Array.isArray(x)) return x;
  if (typeof x === "string") {
    const inside = x.replace(/^\{|\}$/g, "");
    if (!inside) return [];
    return inside
      .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/) // respeta comillas
      .map((s) => s.trim().replace(/^"(.*)"$/, "$1"));
  }
  if (x && typeof x === "object" && Array.isArray((x as any).elements)) {
    return (x as any).elements;
  }
  return [];
}

/**
 * Busca la mejor intención por similitud de patrones.
 * @param umbral: configurable por env INTENT_MATCH_THRESHOLD (default 0.55)
 * @param filtrarPorIdioma: si true, solo considera filas con idioma==idiomaDetectado (si la fila lo define)
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
    filtrarPorIdioma = true,
  } = opts;

  const canales = canalesDe(canal);
  const lang = (idiomaDetectado || "").toLowerCase() || null;

  // Traemos activas ordenadas por prioridad asc
  // 👇 Siempre casteamos a text para parsear en JS de forma uniforme
  const { rows } = await pool.query<IntencionRow>(
    `SELECT id,
            canal,
            nombre,
            COALESCE(ejemplos::text, '{}') AS ejemplos,
            respuesta,
            idioma,
            prioridad,
            activo
       FROM intenciones
      WHERE tenant_id = $1
        AND canal = ANY($2)
        AND activo = TRUE
      ORDER BY prioridad ASC, id ASC`,
    [tenant_id, canales]
  );

  console.log("[INTENTS] rows cargadas=", rows.length);

  const msg = normalize(mensajeUsuario);
  const msgSquashed = squashRepeats(msg);

  let best:
    | { row: IntencionRow; score: number; matchedPattern: string }
    | null = null;

  for (const row of rows) {
    // Filtrado por idioma, solo si la fila define idioma
    if (filtrarPorIdioma && row.idioma && lang && row.idioma.toLowerCase() !== lang) {
      continue;
    }

    const ejemplosArr = toArray(row.ejemplos)
      .map((e) => normalize(e))
      .map((e) => squashRepeats(e));

    const match = bestPatternScore(msgSquashed, ejemplosArr, umbral);

    if (match) {
      console.log(
        "[INTENTS] candidato=",
        row.nombre,
        "score=",
        match.score,
        "patron=",
        match.pattern
      );
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
