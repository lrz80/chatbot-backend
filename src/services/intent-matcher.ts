// 📁 backend/src/services/intent-matcher.ts
import pool from "../lib/db";
import { normalize, bestPatternScore } from "../utils/text-match";

// Sinónimos por intención (no toca DB)
const HINTS: Record<string, string[]> = {
    precio: [
      'precio','precios','cuanto cuesta','cuánto cuesta',
      'costos','tarifas','price','prices','price list','fee','fees','cost'
    ],
    reservar: ['reservar','reserva','agendar','agenda','booking','book'],
    horario:  ['horario','horarios','schedule','time','times'],
    ubicacion: [
      'ubicacion','ubicación','direccion','dirección',
      'address','location','donde estan','dónde estan','como llegar','cómo llegar'
    ],
    clases_online: ['online','en linea','en línea','virtual','clase virtual','clases online'],
  };  

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

// Correcciones rápidas de typos frecuentes (extiende según necesites)
function quickCorrections(s: string) {
  return (s || "")
    // “presios”, “presio”, “preciios” → precio/precios
    .replace(/\bpre(?:s|c)i+o?s?\b/gi, (m) => (m.endsWith("s") ? "precios" : "precio"))
    // transposición “preicos” → “precios”
    .replace(/\bpreicos\b/gi, "precios")
    // “preciso” cuando contexto suele ser precio (muy común en móviles)
    .replace(/\bpreciso\b/gi, "precio");
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

// Distancia Damerau–Levenshtein (con transposición)
function dl(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const d: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i][0] = i;
  for (let j = 0; j <= n; j++) d[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1,       // borrado
        d[i][j - 1] + 1,       // inserción
        d[i - 1][j - 1] + cost // sustitución
      );
      // transposición
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + cost);
      }
    }
  }
  return d[m][n];
}

// Fuzzy match token a token con umbral (1–2 errores)
function fuzzyIncludes(query: string, patterns: string[], maxEdits = 1): { ok: boolean; hit?: string } {
  const q = query.split(/\s+/);
  for (const p of patterns) {
    const pTokens = p.split(/\s+/);
    const qJoin = q.join(" ");
    if (dl(qJoin, p) <= maxEdits) return { ok: true, hit: p };
    for (const qt of q) {
      for (const pt of pTokens) {
        if (dl(qt, pt) <= maxEdits) return { ok: true, hit: p };
      }
    }
  }
  return { ok: false };
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
        AND canal = ANY($2::text[])
        AND activo = TRUE
      ORDER BY prioridad ASC, id ASC`,
    [tenant_id, canales]
  );

  console.log("[INTENTS] rows cargadas=", rows.length);

  // Normaliza input usuario
  const msg0 = normalize(mensajeUsuario);
  const msg1 = quickCorrections(msg0);
  const msgSquashed = squashRepeats(msg1);

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
    .map((e) => quickCorrections(e))
    .map((e) => squashRepeats(e));

    // ➕ Añade HINTS de la intención (sin tocar DB)
    const nombreCanon = String(row.nombre || '').toLowerCase();
    const hintsArr = (HINTS[nombreCanon] || [])
        .map((e) => normalize(e))
        .map((e) => quickCorrections(e))
        .map((e) => squashRepeats(e));

    // 🔄 Unifica y quita duplicados
    const patrones = Array.from(new Set([...ejemplosArr, ...hintsArr]));

    // 0) contain rápido (boost)
    let match: { pattern: string; score: number } | null = null;
    for (const p of patrones) {
        if (p && msgSquashed.includes(p)) {
        match = { pattern: p, score: Math.max(umbral, 0.9) };
        break;
        }
    }

    // 1) scorer normal
    if (!match) {
        match = bestPatternScore(msgSquashed, patrones, umbral);
    }

    // 2) fuzzy 1 error
    if (!match) {
        const f1 = fuzzyIncludes(msgSquashed, patrones, 1);
        if (f1.ok) match = { pattern: f1.hit!, score: Math.max(umbral, 0.6) };
    }

    // 3) fuzzy 2 errores
    if (!match) {
        const f2 = fuzzyIncludes(msgSquashed, patrones, 2);
        if (f2.ok) match = { pattern: f2.hit!, score: Math.max(umbral, 0.55) };
    }

    if (match) {
        console.log(
        "[INTENTS] candidato=",
        row.nombre,
        "score=",
        match.score,
        "patron=",
        match.pattern,
        hintsArr.includes(match.pattern) ? "(via HINTS)" : "(via ejemplos)"
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
