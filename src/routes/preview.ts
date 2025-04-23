// src/routes/preview.ts

import { Router, Request, Response } from 'express';
import pool from '../lib/db';
import OpenAI from 'openai';
import { authenticateUser } from '../middleware/auth';

const router = Router();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

interface AuthenticatedRequest extends Request {
  user?: {
    uid: string;
    tenant_id: string;
    email?: string;
  };
}

router.post('/', authenticateUser, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tenant_id = req.user?.tenant_id;
    const { message } = req.body;

    if (!tenant_id) return res.status(401).json({ error: 'Tenant no autenticado' });

    const tenantRes = await pool.query('SELECT * FROM tenants WHERE id = $1', [tenant_id]);
    const tenant = tenantRes.rows[0];
    if (!tenant) return res.status(404).json({ error: 'Negocio no encontrado' });

    const prompt = tenant.prompt || 'Eres un asistente útil y profesional.';
    const bienvenida = tenant.bienvenida || '¡Hola! ¿En qué puedo ayudarte hoy?';

    // 🔄 Leer flujos si existen
    let flows: any[] = [];
    try {
      const flowsRes = await pool.query('SELECT data FROM flows WHERE tenant_id = $1', [tenant_id]);
      const raw = flowsRes.rows[0]?.data;
      flows = typeof raw === 'string' ? JSON.parse(raw) : raw;
      console.log('📥 Flujos recibidos:', flows);
    } catch (e) {
      console.warn('⚠️ No se pudo obtener o parsear los flujos:', e);
    }

    // 🟢 Si es primer mensaje, responde con bienvenida
    if (!message || message.trim().length < 2) {
      return res.status(200).json({ response: bienvenida });
    }

    // 🔁 Ver si el mensaje coincide con un flujo guiado (primer nivel)
    function buscarEnFlujos(flows: any[], mensaje: string): string | null {
      for (const flow of flows) {
        for (const opcion of flow.opciones || []) {
          if (opcion.texto.toLowerCase().includes(mensaje.toLowerCase())) {
            return opcion.respuesta || null;
          }
          if (opcion.submenu) {
            for (const sub of opcion.submenu.opciones || []) {
              if (sub.texto.toLowerCase().includes(mensaje.toLowerCase())) {
                return sub.respuesta || null;
              }
            }
          }
        }
      }
      return null;
    }
    
    const respuestaFlujo = buscarEnFlujos(flows, message);
    if (respuestaFlujo) {
      return res.status(200).json({ response: respuestaFlujo });
    }

    // ✨ OpenAI fallback
    const completion = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: message },
      ],
    });

    const response = completion.choices[0].message?.content || 'Lo siento, no entendí eso.';
    return res.status(200).json({ response });
  } catch (err) {
    console.error('❌ Error en preview:', err);
    return res.status(500).json({ error: 'Error interno' });
  }
});

export default router;
