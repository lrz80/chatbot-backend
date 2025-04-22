import { Router, Request, Response } from 'express';
import jwt, { JwtPayload } from 'jsonwebtoken';
import pool from '../lib/db';

const router: Router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'secret-key';

// GET: Obtener perfil del negocio
router.get('/', async (req: Request, res: Response) => {
  const token = req.cookies.token;

  if (!token) {
    return res.status(401).json({ error: 'Token requerido' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;

    const userRes = await pool.query('SELECT * FROM users WHERE uid = $1', [decoded.uid]);
    const user = userRes.rows[0];
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

    const tenantRes = await pool.query(
      'SELECT * FROM tenants WHERE id = $1',
      [user.tenant_id]
    );
    
    const tenant = tenantRes.rows[0];

    return res.status(200).json({
      uid: user.uid,
      email: user.email,
      owner_name: user.owner_name,
      membresia_activa: tenant?.membresia_activa ?? false,
      membresia_vigencia: tenant?.membresia_vigencia ?? null,
      onboarding_completado: tenant.onboarding_completado,
      name: tenant?.name || '',
      categoria: tenant?.categoria || '',
      idioma: tenant?.idioma || 'es',
      prompt: tenant?.prompt || '',
      bienvenida: tenant?.bienvenida || '',
      direccion: tenant?.direccion || '',
      horario_atencion: tenant?.horario_atencion || '',
      twilio_number: tenant?.twilio_number || '',
      twilio_sms_number: tenant?.twilio_sms_number || '',
      twilio_voice_number: tenant?.twilio_voice_number || '',
      informacion_negocio: tenant?.informacion_negocio || '',
      funciones_asistente: tenant?.funciones_asistente || '',
      info_clave: tenant?.info_clave || '',
      limite_uso: tenant?.limite_uso || 150,
    });
  } catch (error) {
    console.error('❌ Error en /api/settings:', error);
    return res.status(401).json({ error: 'Token inválido' });
  }
});

// POST: Actualizar perfil del negocio
router.post('/', async (req: Request, res: Response) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: 'Token requerido' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;

    const {
      nombre_negocio,
      categoria,
      idioma,
      direccion,
      horario_atencion,
      prompt,
      bienvenida,
      twilio_number,
      twilio_sms_number,
      twilio_voice_number,
      informacion_negocio,
      funciones_asistente,
      info_clave,
      limite_uso,
    } = req.body;

    if (!nombre_negocio) {
      return res.status(400).json({ error: 'El nombre del negocio es obligatorio' });
    }

    const userRes = await pool.query('SELECT * FROM users WHERE uid = $1', [decoded.uid]);
    const user = userRes.rows[0];
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

    const tenantRes = await pool.query('SELECT * FROM tenants WHERE admin_uid = $1', [user.uid]);
    if (tenantRes.rows.length === 0) {
      return res.status(404).json({ error: 'Negocio no encontrado' });
    }

    await pool.query(
      `UPDATE tenants SET 
        name = $1,
        categoria = $2,
        idioma = $3,
        direccion = $4,
        horario_atencion = $5,
        prompt = $6,
        bienvenida = $7,
        twilio_number = $8,
        twilio_sms_number = $9,
        twilio_voice_number = $10,
        informacion_negocio = $11,
        funciones_asistente = $12,
        info_clave = $13,
        limite_uso = $14
      WHERE admin_uid = $15`,
      [
        nombre_negocio,
        categoria || '',
        idioma || 'es',
        direccion || '',
        horario_atencion || '',
        prompt || '',
        bienvenida || '',
        twilio_number || '',
        twilio_sms_number || '',
        twilio_voice_number || '',
        informacion_negocio || '',
        funciones_asistente || '',
        info_clave || '',
        limite_uso || 150,
        user.uid,
      ]
    );

    return res.status(200).json({ message: 'Perfil actualizado correctamente' });
  } catch (error) {
    console.error('❌ Error al actualizar perfil:', error);
    return res.status(500).json({ error: 'Error al guardar cambios' });
  }
});

// PUT: Actualizar perfil del negocio (igual que POST)
router.put('/', async (req: Request, res: Response) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: 'Token requerido' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;

    const {
      nombre_negocio,
      categoria,
      idioma,
      direccion,
      horario_atencion,
      prompt,
      bienvenida,
      informacion_negocio,
      funciones_asistente,
      info_clave,
      limite_uso,
    } = req.body;

    // 🚫 Ignorar campos protegidos de Twilio
    delete req.body.twilio_number;
    delete req.body.twilio_sms_number;
    delete req.body.twilio_voice_number;

    const userRes = await pool.query('SELECT * FROM users WHERE uid = $1', [decoded.uid]);
    const user = userRes.rows[0];
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

    const tenantRes = await pool.query('SELECT * FROM tenants WHERE admin_uid = $1', [user.uid]);
    if (tenantRes.rows.length === 0) {
      return res.status(404).json({ error: 'Negocio no encontrado' });
    }

    await pool.query(
      `UPDATE tenants SET 
        name = $1,
        categoria = $2,
        idioma = $3,
        direccion = $4,
        horario_atencion = $5,
        prompt = $6,
        bienvenida = $7,
        informacion_negocio = $8,
        funciones_asistente = $9,
        info_clave = $10,
        limite_uso = $11,
        onboarding_completado = true
      WHERE admin_uid = $12`,
      [
        nombre_negocio,
        categoria || '',
        idioma || 'es',
        direccion || '',
        horario_atencion || '',
        prompt || '',
        bienvenida || '',
        informacion_negocio || '',
        funciones_asistente || '',
        info_clave || '',
        limite_uso || 150,
        user.uid,
      ]
    );

    return res.status(200).json({ message: 'Perfil actualizado correctamente' });
  } catch (error) {
    console.error('❌ Error en PUT /api/settings:', error);
    return res.status(500).json({ error: 'Error al guardar cambios' });
  }
});

export default router;
