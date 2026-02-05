// src/lib/recoPrincipiantes/interceptor.ts
import pool from '../db';
import { esPreguntaRecomendacion } from './detectores';
import { loadTiposClases, TipoClase } from './tiposClases';
import { buildBeginnerRecoMessage } from './construirMensaje';
import { detectarIdioma } from '../detectarIdioma';
import { traducirMensaje } from '../traducirMensaje';

type InterceptorArgs = {
  tenantId: string;
  canal: 'whatsapp' | 'facebook' | 'instagram' | 'preview';
  fromNumber: string;            // o senderId para FB/IG
  userInput: string;
  idiomaDestino: 'es' | 'en';
  intencionParaFaq: string;      // ya calculada aguas arriba
  promptBase: string;
  enviarFn: (to: string, text: string, tenantId: string) => Promise<void>;
};

// Detecta si tenantId “parece” UUID v1–v5
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function runBeginnerRecoInterceptor(args: InterceptorArgs): Promise<boolean> {
  const {
    tenantId, canal, fromNumber, userInput,
    idiomaDestino, intencionParaFaq, promptBase, enviarFn
  } = args;

  // Solo aplica si la intención es interes_clases y la pregunta es tipo “¿cuál recomiendas?”
  if (!(intencionParaFaq === 'interes_clases' && esPreguntaRecomendacion(userInput))) {
    return false;
  }

  // Normalización
  const preguntaNormalizada = userInput
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();

  const intencionFinal = 'duda__recomendacion_principiantes';

  // 1) Registrar FAQ sugerida evitando duplicados exactos no-procesados
  const isUuid = UUID_RE.test(tenantId);
  const insertFaqSql = isUuid
    ? `
      INSERT INTO faq_sugeridas
        (tenant_id, canal, pregunta, respuesta_sugerida, idioma, procesada, ultima_fecha, intencion)
      SELECT *
      FROM (
        SELECT
          $1::uuid  AS tenant_id,
          $2::text  AS canal,
          $3::text  AS pregunta,
          $4::text  AS respuesta_sugerida,
          $5::text  AS idioma,
          false     AS procesada,
          NOW()     AS ultima_fecha,
          $6::text  AS intencion
      ) AS vals
      WHERE NOT EXISTS (
        SELECT 1
        FROM faq_sugeridas f
        WHERE f.tenant_id = vals.tenant_id
          AND f.canal     = vals.canal
          AND f.pregunta  = vals.pregunta
          AND f.procesada = false
      );
    `
    : `
      INSERT INTO faq_sugeridas
        (tenant_id, canal, pregunta, respuesta_sugerida, idioma, procesada, ultima_fecha, intencion)
      SELECT *
      FROM (
        SELECT
          $1::text  AS tenant_id,
          $2::text  AS canal,
          $3::text  AS pregunta,
          $4::text  AS respuesta_sugerida,
          $5::text  AS idioma,
          false     AS procesada,
          NOW()     AS ultima_fecha,
          $6::text  AS intencion
      ) AS vals
      WHERE NOT EXISTS (
        SELECT 1
        FROM faq_sugeridas f
        WHERE f.tenant_id = vals.tenant_id
          AND f.canal     = vals.canal
          AND f.pregunta  = vals.pregunta
          AND f.procesada = false
      );
    `;

  try {
    await pool.query(insertFaqSql, [tenantId, canal, preguntaNormalizada, '', idiomaDestino, intencionFinal]);
  } catch (e) {
    console.warn('⚠️ BeginnerReco: no se pudo registrar faq_sugeridas:', e);
  }

  // 2) Cargar tipos de clases (DB / settings / prompt / heurística)
  let tipos: TipoClase[] = [];
  let fuente = 'vacio';

  try {
    // Compatibilidad con ambas firmas:
    //   - nueva: loadTiposClases(tenantId, { promptBase }) -> { tipos, fuente }
    //   - antigua: loadTiposClases(tenantId) -> TipoClase[]
    const res: any = await (loadTiposClases as any)(tenantId, { promptBase });

    if (Array.isArray(res)) {
      // Firma antigua
      tipos = res as TipoClase[];
      fuente = 'legacy';
    } else {
      // Firma nueva
      tipos = Array.isArray(res?.tipos) ? (res.tipos as TipoClase[]) : [];
      fuente = String(res?.fuente || 'desconocida');
    }
  } catch (e) {
    console.warn('⚠️ BeginnerReco: error en loadTiposClases:', e);
    tipos = [];
    fuente = 'error';
  }

  console.log('🎯 BeginnerReco: tipos_clases cargados', {
    tenantId,
    canal,
    fuente,
    total: tipos.length,
    preview: tipos.slice(0, 3),
  });

  // 3) Construir mensaje principal
  let msg: string | null = null;
  try {
    msg = await buildBeginnerRecoMessage(tipos, promptBase, idiomaDestino);
  } catch (e) {
    console.warn('⚠️ BeginnerReco: error construyendo mensaje:', e);
    msg = null;
  }

  // 3.1) Fallback si no hay tipos o el builder devolvió vacío
  if (!msg || !msg.trim()) {
    msg = (idiomaDestino === 'en')
      ? `Great question! For your first time, we usually suggest starting with a lower-intensity “Beginner / Level 1” class to learn technique and pacing comfortably. Tell me your current fitness level and I’ll point you to the best fit.`
      : `¡Excelente pregunta! Para tu primera vez, solemos sugerir comenzar con una clase de menor intensidad “Principiantes / Nivel 1” para aprender técnica y ritmo con comodidad. Cuéntame tu nivel actual y te indico la mejor opción.`;
  }

  // 4) Añadir (si existe) FAQ oficial 'interes_clases' (p.ej., link de reserva)
  try {
    const { rows } = await pool.query(
      `SELECT respuesta FROM faqs
       WHERE tenant_id = $1 AND canal = $2 AND LOWER(intencion) = 'interes_clases'
       LIMIT 1`,
      [tenantId, canal]
    );
    if (rows[0]?.respuesta) {
      let extra = rows[0].respuesta as string;
            try {
        const raw = await detectarIdioma(extra);
        const norm = String(raw || "").toLowerCase().split(/[-_]/)[0];
        const lang: "es" | "en" | null =
          norm === "en" ? "en" :
          norm === "es" ? "es" :
          null;

        if (lang && lang !== idiomaDestino) {
          extra = await traducirMensaje(extra, idiomaDestino);
        }
      } catch {}
      // Evita duplicar si ya fue incluido por el builder
      if (!msg.includes(extra.slice(0, 24))) {
        msg += `\n\n${extra}`;
      }
    }
  } catch (e) {
    console.warn('⚠️ BeginnerReco: no se pudo anexar FAQ interes_clases:', e);
  }

  // 5) Garantizar idiomaDestino
    try {
    const raw = await detectarIdioma(msg);
    const norm = String(raw || "").toLowerCase().split(/[-_]/)[0];
    const det: "es" | "en" | null =
      norm === "en" ? "en" :
      norm === "es" ? "es" :
      null;

    if (det && det !== idiomaDestino) {
      msg = await traducirMensaje(msg, idiomaDestino);
    }
  } catch {}

  console.log('✅ BeginnerReco: respuesta lista', {
    to: fromNumber, canal, idiomaDestino, len: msg.length
  });

  // 6) Enviar
  await enviarFn(fromNumber, msg, tenantId);

  return true; // interceptado y respondido
}
