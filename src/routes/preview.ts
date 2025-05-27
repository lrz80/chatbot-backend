import { Router, Request, Response } from 'express';
import pool from '../lib/db';
import { authenticateUser } from '../middleware/auth';
import { getPromptPorCanal, getBienvenidaPorCanal } from '../lib/getPromptPorCanal';
import { detectarIdioma } from '../lib/detectarIdioma';
import { traducirMensaje } from '../lib/traducirMensaje';
import { buscarRespuestaSimilitudFaqsTraducido, buscarRespuestaDesdeFlowsTraducido } from '../lib/respuestasTraducidas';

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

router.post('/', authenticateUser, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tenant_id = req.user?.tenant_id;
    const { message, canal = 'preview-meta' } = req.body;

    if (!tenant_id) return res.status(401).json({ error: 'Tenant no autenticado' });

    const tenantRes = await pool.query('SELECT * FROM tenants WHERE id = $1', [tenant_id]);
    const tenant = tenantRes.rows[0];
    if (!tenant) return res.status(404).json({ error: 'Negocio no encontrado' });

    const idioma = await detectarIdioma(message);
    const prompt = await getPromptPorCanal(canal, tenant, idioma);
    const bienvenida = await getBienvenidaPorCanal(canal, tenant, idioma);
    const mensajeUsuario = normalizarTexto(message);

    if (['hola', 'buenas', 'hello', 'hi', 'hey'].includes(mensajeUsuario)) {
      return res.status(200).json({ response: bienvenida });
    }

    let faqs: any[] = [];
    try {
      const faqsRes = await pool.query('SELECT pregunta, respuesta FROM faqs WHERE tenant_id = $1', [tenant_id]);
      faqs = faqsRes.rows || [];
    } catch (e) {
      console.warn('⚠️ No se pudieron cargar FAQs:', e);
    }

    let flows: any[] = [];
    try {
      const flowsRes = await pool.query('SELECT data FROM flows WHERE tenant_id = $1', [tenant_id]);
      const raw = flowsRes.rows[0]?.data;
      flows = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!Array.isArray(flows)) flows = [];
    } catch (e) {
      flows = [];
      console.warn('⚠️ No se pudieron cargar Flows:', e);
    }

    let respuesta = await buscarRespuestaSimilitudFaqsTraducido(faqs, message, idioma)
      ?? await buscarRespuestaDesdeFlowsTraducido(flows, message, idioma);

      if (!respuesta) {
        const { default: OpenAI } = await import('openai');
        const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });
      
        // 📝 Personalización con el nombre del negocio (tenant.name)
        const contacto = tenant.email || 'nuestro equipo';
        let promptFinal = prompt.trim() !== '' 
          ? prompt 
          : `Eres un asistente virtual de ${tenant.name}. Si el cliente pregunta por precios u otros detalles y no tienes información, indícale amablemente que contacte directamente a ${contacto}. No inventes datos.`;

        const completion = await openai.chat.completions.create({
          model: "gpt-3.5-turbo",
          messages: [
            { role: 'system', content: promptFinal },
            { role: 'user', content: message },
          ],
        });
      
        respuesta = completion.choices[0]?.message?.content?.trim() ?? bienvenida ?? 'Lo siento, no entendí eso.';
      }      

    const idiomaFinal = await detectarIdioma(respuesta);
    if (idiomaFinal !== idioma) {
      respuesta = await traducirMensaje(respuesta, idioma);
    }

    res.status(200).json({ response: respuesta });

  } catch (err) {
    console.error('❌ Error en preview:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

export default router;
