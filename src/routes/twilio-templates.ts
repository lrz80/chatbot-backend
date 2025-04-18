// src/routes/twilio-templates.ts
import { Router, Request, Response } from 'express';
import { twilioClient } from '../lib/twilio'; // Asegúrate de tener esta configuración
import jwt, { JwtPayload } from 'jsonwebtoken';

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'secret-key';

router.get('/', async (req: Request, res: Response) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: 'Token requerido' });

  try {
    jwt.verify(token, JWT_SECRET); // puedes validar más si deseas

    const templates = await twilioClient.messaging.v1
      .services(process.env.TWILIO_MESSAGING_SERVICE_SID!)
      .templates.list();

    res.status(200).json(templates);
  } catch (err) {
    console.error('❌ Error al obtener plantillas:', err);
    res.status(500).json({ error: 'Error al obtener plantillas' });
  }
});

export default router;
