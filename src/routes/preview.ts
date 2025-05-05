// ✅ src/routes/preview.ts

import { Router, Request, Response } from 'express';
import pool from '../lib/db';
import { authenticateUser } from '../middleware/auth';
import { getPromptPorCanal, getBienvenidaPorCanal } from '../lib/getPromptPorCanal';
import { buscarRespuestaDesdeFlows } from '../lib/buscarRespuestaDesdeFlows';


const router = Router();

interface AuthenticatedRequest extends Request {
  user?: {
    uid: string;
    tenant_id: string;
    email?: string;
  };
}

// 🔍 Función para normalizar texto (quita tildes, minúsculas, espacios)
function normalizarTexto(texto: string): string {
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

router.post('/', authenticateUser, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tenant_id = req.user?.tenant_id;
    const { message } = req.body;
    const canal = req.body.canal || 'preview-meta';

    if (!tenant_id) return res.status(401).json({ error: 'Tenant no autenticado' });

    const tenantRes = await pool.query('SELECT * FROM tenants WHERE id = $1', [tenant_id]);
    const tenant = tenantRes.rows[0];
    if (!tenant) return res.status(404).json({ error: 'Negocio no encontrado' });

    const prompt = getPromptPorCanal(canal, tenant);
    const mensajeUsuario = normalizarTexto(message);

    // ✅ Mostrar saludo si es un saludo inicial
    if (['hola', 'buenas', 'hello', 'hi', 'hey'].includes(mensajeUsuario)) {
      const saludo = getBienvenidaPorCanal(canal, tenant);
      return res.status(200).json({ response: saludo });
    }

    // 📋 Cargar FAQs
    let faqs: any[] = [];
    try {
      const faqsRes = await pool.query('SELECT pregunta, respuesta FROM faqs WHERE tenant_id = $1', [tenant_id]);
      faqs = faqsRes.rows || [];
    } catch (e) {
      console.warn('⚠️ No se pudieron cargar FAQs:', e);
    }

    for (const faq of faqs) {
      if (mensajeUsuario.includes(normalizarTexto(faq.pregunta))) {
        console.log('📌 Respondido desde FAQ:', faq.pregunta);
        return res.status(200).json({ response: faq.respuesta });
      }
    }    

    // 📋 Cargar Flows
    let flows: any[] = [];
    try {
      const flowsRes = await pool.query('SELECT data FROM flows WHERE tenant_id = $1', [tenant_id]);
      const raw = flowsRes.rows[0]?.data;
      flows = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (e) {
      console.warn('⚠️ No se pudieron cargar Flows:', e);
    }

    const respuestaFlujo = buscarRespuestaDesdeFlows(flows, message);
    if (respuestaFlujo) {
      console.log('📌 Respondido desde Flow:', respuestaFlujo);
      return res.status(200).json({ response: respuestaFlujo });
    }    

    // 🧠 OpenAI fallback solo si no encontró en FAQs ni Flows
    const { default: OpenAI } = await import('openai');
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });

    const completion = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: message },
      ],
    });

    const respuestaIA = completion.choices[0]?.message?.content?.trim() || getBienvenidaPorCanal(canal, tenant) || 'Lo siento, no entendí eso.';
    console.log("✅ Respuesta generada por OpenAI:", respuestaIA);  // 🔍 LOG PARA DEBUG
    return res.status(200).json({ response: respuestaIA });

  } catch (err) {
    console.error('❌ Error en preview:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

export default router;
