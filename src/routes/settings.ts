import express from 'express';
import { Request, Response } from 'express';
import jwt, { JwtPayload } from 'jsonwebtoken';
import pool from '../lib/db';
import { authenticateUser } from '../middleware/auth';

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'secret-key';

// ✅ GET: Perfil del negocio
router.get('/', authenticateUser, async (req: any, res: Response) => {
  try {
    const uid = req.user?.uid;
    const tenant_id = req.user?.tenant_id;

    if (!tenant_id) {
      return res.status(401).json({ error: 'Tenant no encontrado o no asignado' });
    }

    const userRes = await pool.query('SELECT * FROM users WHERE uid = $1', [uid]);
    const user = userRes.rows[0];
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

    const tenantRes = await pool.query('SELECT * FROM tenants WHERE id = $1', [tenant_id]);
    const tenant = tenantRes.rows[0];
    if (!tenant) return res.status(404).json({ error: 'Tenant no encontrado' });

    return res.status(200).json({
      uid: user.uid,
      email: user.email,
      owner_name: user.owner_name,
      membresia_activa: tenant.membresia_activa ?? false,
      membresia_vigencia: tenant.membresia_vigencia ?? null,
      onboarding_completado: tenant.onboarding_completado,
      name: tenant.name || '',
      categoria: tenant.categoria || '',
      idioma: tenant.idioma || 'es',
      prompt: tenant.prompt || '',
      bienvenida: tenant.bienvenida || '',
      direccion: tenant.direccion || '',
      horario_atencion: tenant.horario_atencion || '',
      twilio_number: tenant.twilio_number || '',
      twilio_sms_number: tenant.twilio_sms_number || '',
      twilio_voice_number: tenant.twilio_voice_number || '',
      informacion_negocio: tenant.informacion_negocio || '',
      funciones_asistente: tenant.funciones_asistente || '',
      info_clave: tenant.info_clave || '',
      limite_uso: tenant.limite_uso || 150,
    });
  } catch (error) {
    console.error('❌ Error en /api/settings:', error);
    return res.status(401).json({ error: 'Token inválido' });
  }
});

router.post('/', authenticateUser, async (req: any, res: Response) => {
  try {
    const tenant_id = req.user?.tenant_id;

    if (!tenant_id) {
      return res.status(401).json({ error: 'Tenant no autenticado' });
    }

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

    if (!nombre_negocio) {
      return res.status(400).json({ error: 'El nombre del negocio es obligatorio' });
    }

    // ✅ Obtener valores actuales del tenant
    const current = await pool.query('SELECT * FROM tenants WHERE id = $1', [tenant_id]);
    const existing = current.rows[0];
    if (!existing) return res.status(404).json({ error: 'Negocio no encontrado' });

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
      WHERE id = $15`,
      [
        nombre_negocio,
        categoria ?? existing.categoria,
        idioma ?? existing.idioma,
        direccion ?? existing.direccion,
        horario_atencion ?? existing.horario_atencion,
        prompt ?? existing.prompt,
        bienvenida ?? existing.bienvenida,
        existing.twilio_number,
        existing.twilio_sms_number,
        existing.twilio_voice_number,
        informacion_negocio ?? existing.informacion_negocio,
        funciones_asistente?.trim() !== "" ? funciones_asistente : existing.funciones_asistente,
        info_clave ?? existing.info_clave,
        limite_uso ?? existing.limite_uso,
        tenant_id,
      ]
    );

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('❌ Error en POST /api/settings:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

router.put('/', authenticateUser, async (req: any, res: Response) => {
  try {
    const tenant_id = req.user?.tenant_id;
    if (!tenant_id) {
      return res.status(401).json({ error: 'Tenant no autenticado' });
    }

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

    // 🚫 Eliminar campos protegidos de Twilio si se intentan enviar
    delete req.body.twilio_number;
    delete req.body.twilio_sms_number;
    delete req.body.twilio_voice_number;

    // 🧠 Obtener valores actuales
    const existingRes = await pool.query('SELECT * FROM tenants WHERE id = $1', [tenant_id]);
    const current = existingRes.rows[0];
    if (!current) return res.status(404).json({ error: 'Tenant no encontrado' });

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
      WHERE id = $12`,
      [
        nombre_negocio || current.name,
        categoria || current.categoria,
        idioma || current.idioma,
        direccion || current.direccion,
        horario_atencion || current.horario_atencion,
        prompt || current.prompt,
        bienvenida || current.bienvenida,
        informacion_negocio || current.informacion_negocio,
        funciones_asistente || current.funciones_asistente,
        info_clave || current.info_clave,
        limite_uso || current.limite_uso,
        tenant_id,
      ]
    );

    return res.status(200).json({ message: 'Perfil actualizado correctamente' });
  } catch (error) {
    console.error('❌ Error en PUT /api/settings:', error);
    return res.status(500).json({ error: 'Error al guardar cambios' });
  }
});


export default router;
