import { Router, Request, Response } from 'express';
import jwt, { JwtPayload } from 'jsonwebtoken';
import pool from '../lib/db';
import OpenAI from 'openai';

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'secret-key';
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

router.post('/', async (req: Request, res: Response) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: 'Token requerido' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;
    const { message } = req.body;

    const tenantRes = await pool.query('SELECT * FROM tenants WHERE admin_uid = $1', [decoded.uid]);
    const tenant = tenantRes.rows[0];
    if (!tenant) return res.status(404).json({ error: 'Negocio no encontrado' });

    const prompt = tenant.prompt || 'Eres un asistente útil y profesional.';
    const bienvenida = tenant.bienvenida || '¡Hola! ¿En qué puedo ayudarte?';

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
