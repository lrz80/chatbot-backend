//src/routes/preview.ts

import { Router, Request, Response } from 'express';
import pool from '../lib/db';
import { authenticateUser } from '../middleware/auth';
import { getPromptPorCanal, getBienvenidaPorCanal } from '../lib/getPromptPorCanal';
import { detectarIdioma } from '../lib/detectarIdioma';
import { traducirMensaje } from '../lib/traducirMensaje';
import {
  buscarRespuestaSimilitudFaqsTraducido,
  buscarRespuestaDesdeFlowsTraducido,
} from '../lib/respuestasTraducidas';

const router = Router();

interface AuthenticatedRequest extends Request {
  user?: {
    uid: string;
    tenant_id: string;
    email?: string;
  };
}

function normalizarTexto(texto: string): string {
  return texto.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}

/**
 * Handler reutilizable para las vistas previas de WhatsApp y Meta.
 * - Orden: Flows → FAQs → OpenAI
 * - Filtrado por canal en Flows y FAQs
 * - Multi-idioma: detección + traducción (las funciones *Traducido ya lo manejan)
 * - Sin side effects (no incrementa used ni escribe en DB)
 */
async function handlePreview(
  req: AuthenticatedRequest,
  res: Response,
  canalReal: 'whatsapp' | 'meta'
) {
  try {
    const tenant_id = req.user?.tenant_id;
    const { message } = req.body as { message: string };

    if (!tenant_id) return res.status(401).json({ error: 'Tenant no autenticado' });
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Mensaje inválido' });
    }

    // 🔎 Cargar tenant
    const tenantRes = await pool.query('SELECT * FROM tenants WHERE id = $1', [tenant_id]);
    const tenant = tenantRes.rows[0];
    if (!tenant) return res.status(404).json({ error: 'Negocio no encontrado' });

    // 🌐 Detección de idioma de entrada
    const idioma = await detectarIdioma(message);

    // 🧠 Prompt y bienvenida por canal + idioma
    const prompt = await getPromptPorCanal(canalReal, tenant, idioma);
    const bienvenida = await getBienvenidaPorCanal(canalReal, tenant, idioma);

    const mensajeUsuario = normalizarTexto(message);
    if (['hola', 'buenas', 'hello', 'hi', 'hey'].includes(mensajeUsuario)) {
      return res.status(200).json({ response: bienvenida, kind: 'welcome' });
    }

    // 🎛️ Canales a considerar por tipo
    // Para Meta unificamos 'meta' | 'facebook' | 'instagram' (igual que en tus webhooks reales)
    const canalesFaq =
      canalReal === 'meta' ? ['meta', 'facebook', 'instagram'] : ['whatsapp'];
    const canalesFlow =
      canalReal === 'meta' ? ['meta', 'facebook', 'instagram'] : ['whatsapp'];

    // 📚 Cargar FAQs por canal (multi-idioma lo maneja buscarRespuestaSimilitudFaqsTraducido)
    let faqs: Array<{ pregunta: string; respuesta: string }> = [];
    try {
      const faqsRes = await pool.query(
        `
        SELECT pregunta, respuesta
        FROM faqs
        WHERE tenant_id = $1
          AND canal = ANY($2::text[])
        `,
        [tenant_id, canalesFaq]
      );
      faqs = faqsRes.rows || [];
    } catch (e) {
      console.warn('⚠️ No se pudieron cargar FAQs:', e);
      faqs = [];
    }

    // 🧭 Cargar Flows por canal
    // Asumimos que tu tabla `flows` tiene columna `canal`. Si no, quita el filtro canal y déjalo solo por tenant.
    let flows: any[] = [];
    try {
      const flowsRes = await pool.query(
        `
        SELECT data
        FROM flows
        WHERE tenant_id = $1
          AND canal = ANY($2::text[])
        ORDER BY updated_at DESC NULLS LAST, id DESC
        LIMIT 1
        `,
        [tenant_id, canalesFlow]
      );
      const raw = flowsRes.rows[0]?.data;
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      flows = Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      console.warn('⚠️ No se pudieron cargar Flows:', e);
      flows = [];
    }

    // ✅ ORDEN: Flows → FAQs → OpenAI

    // 1) Flujos guiados (puede devolver texto o estructura con botones/opciones)
    let respuesta: any = await buscarRespuestaDesdeFlowsTraducido(flows, message, idioma);
    if (respuesta) {
      if (typeof respuesta === 'object' && respuesta !== null) {
        // Respuesta estructurada (texto + opciones/botones)
        return res.status(200).json({ response: respuesta, kind: 'flow' });
      }
      // Si fue solo texto, homogenizamos idioma de salida
      const idiomaFlow = await detectarIdioma(respuesta);
      if (idiomaFlow !== idioma) respuesta = await traducirMensaje(respuesta, idioma);
      return res.status(200).json({ response: respuesta, kind: 'flow' });
    }

    // 2) FAQs (similaridad + multi-idioma manejado en la función *Traducido)
    respuesta = await buscarRespuestaSimilitudFaqsTraducido(faqs, message, idioma);
    if (respuesta) {
      const idiomaFaq = await detectarIdioma(respuesta);
      if (idiomaFaq !== idioma) respuesta = await traducirMensaje(respuesta, idioma);
      return res.status(200).json({ response: respuesta, kind: 'faq' });
    }

    // 3) Fallback: OpenAI con prompt del canal
    const { default: OpenAI } = await import('openai');
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });

    const contacto = tenant.email || 'nuestro equipo';
    const promptFinal =
      (prompt?.trim?.() || '') !== ''
        ? prompt
        : `Eres un asistente virtual de ${tenant.name}. Si el cliente pregunta por precios u otros detalles y no tienes información, indícale amablemente que contacte directamente a ${contacto}. No inventes datos.`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: promptFinal },
        { role: 'user', content: message },
      ],
    });

    let texto = completion.choices[0]?.message?.content?.trim() ?? bienvenida ?? 'Lo siento, no entendí eso.';
    const idiomaAI = await detectarIdioma(texto);
    if (idiomaAI !== idioma) texto = await traducirMensaje(texto, idioma);

    return res.status(200).json({ response: texto, kind: 'ai' });
  } catch (err) {
    console.error('❌ Error en preview:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

/**
 * Endpoints separados por página:
 * - /preview/whatsapp → usa canalReal = 'whatsapp'
 * - /preview/meta     → usa canalReal = 'meta' (unifica facebook/instagram)
 */
router.post('/whatsapp', authenticateUser, async (req, res) => {
  return handlePreview(req as AuthenticatedRequest, res, 'whatsapp');
});

router.post('/meta', authenticateUser, async (req, res) => {
  return handlePreview(req as AuthenticatedRequest, res, 'meta');
});

export default router;
