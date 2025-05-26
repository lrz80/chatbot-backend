import express from 'express';
import { Request, Response } from 'express';
import pool from '../lib/db';
import { authenticateUser } from '../middleware/auth';

const router = express.Router();

// ✅ GET: Perfil del negocio + FAQs e Intents por canal
router.get('/', authenticateUser, async (req: any, res: Response) => {
  console.log('🧪 Entró al endpoint /api/settings');
  try {
    const uid = req.user?.uid;
    const tenant_id = req.user?.tenant_id;

    if (!tenant_id) {
      return res.status(401).json({ error: 'Tenant no encontrado o no asignado' });
    }

    const userRes = await pool.query('SELECT uid, email, owner_name FROM users WHERE uid = $1', [uid]);
    const user = userRes.rows[0];
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

    const tenantRes = await pool.query(`
      SELECT 
        * 
      FROM tenants 
      WHERE id = $1
      LIMIT 1
    `, [tenant_id]);
    const tenant = tenantRes.rows[0];
    if (!tenant) return res.status(404).json({ error: 'Tenant no encontrado' });

    // ✅ Canal actual (viene por query string, por defecto 'whatsapp')
    const canal = req.query.canal || 'whatsapp';

    // ✅ Traer FAQs e Intents del canal específico
    const faqsRes = await pool.query(
      'SELECT id, pregunta, respuesta FROM faqs WHERE tenant_id = $1 AND canal = $2 ORDER BY id',
      [tenant_id, canal]
    );
    const intentsRes = await pool.query(
      'SELECT id, nombre, ejemplos, respuesta FROM intents WHERE tenant_id = $1 AND canal = $2 ORDER BY id',
      [tenant_id, canal]
    );

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
      bienvenida: tenant.mensaje_bienvenida || '',
      direccion: tenant.direccion || '',
      horario_atencion: tenant.horario_atencion || '',
      twilio_number: tenant.twilio_number || '',
      twilio_sms_number: tenant.twilio_sms_number || '',
      twilio_voice_number: tenant.twilio_voice_number || '',
      informacion_negocio: tenant.informacion_negocio || '',
      funciones_asistente: tenant.funciones_asistente || '',
      info_clave: tenant.info_clave || '',
      logo_url: tenant.logo_url || '',
      plan: tenant.plan || '',
      fecha_registro: tenant.fecha_registro || null,
    
      // Datos Meta
      facebook_page_id: tenant.facebook_page_id || '',
      facebook_page_name: tenant.facebook_page_name || '',
      facebook_access_token: tenant.facebook_access_token || '',
      instagram_page_id: tenant.instagram_page_id || '',
      instagram_page_name: tenant.instagram_page_name || '',
    
      // ✅ Nuevos datos por canal
      faq: faqsRes.rows,
      intents: intentsRes.rows,
    });
    
  } catch (error) {
    console.error('❌ Error en GET /api/settings:', error);
    return res.status(401).json({ error: 'Token inválido' });
  }
});

// ✅ POST: Guardar cambios iniciales del negocio + faqs/intents por canal
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
      logo_url,
      faq = [],
      intents = [],
      canal = 'whatsapp'
    } = req.body;

    if (!nombre_negocio) {
      return res.status(400).json({ error: 'El nombre del negocio es obligatorio' });
    }

    const current = await pool.query('SELECT * FROM tenants WHERE id = $1', [tenant_id]);
    const existing = current.rows[0];
    if (!existing) return res.status(404).json({ error: 'Negocio no encontrado' });

    // ✅ Actualizar datos generales del negocio
    await pool.query(
      `UPDATE tenants SET 
        name = $1,
        categoria = $2,
        idioma = $3,
        direccion = $4,
        horario_atencion = $5,
        prompt = $6,
        mensaje_bienvenida = $7,
        twilio_number = $8,
        twilio_sms_number = $9,
        twilio_voice_number = $10,
        informacion_negocio = $11,
        funciones_asistente = $12,
        info_clave = $13,
        logo_url = $14
      WHERE id = $15`,
      [
        nombre_negocio,
        categoria ?? existing.categoria,
        idioma ?? existing.idioma,
        direccion ?? existing.direccion,
        horario_atencion ?? existing.horario_atencion,
        prompt ?? existing.prompt,
        bienvenida ?? existing.mensaje_bienvenida,
        existing.twilio_number,
        existing.twilio_sms_number,
        existing.twilio_voice_number,
        informacion_negocio ?? existing.informacion_negocio,
        funciones_asistente?.trim() !== '' ? funciones_asistente : existing.funciones_asistente,
        info_clave ?? existing.info_clave,
        logo_url ?? existing.logo_url,
        tenant_id,
      ]
    );

    // ✅ Guardar FAQs por canal
    await pool.query('DELETE FROM faqs WHERE tenant_id = $1 AND canal = $2', [tenant_id, canal]);
    for (const item of faq) {
      await pool.query(
        'INSERT INTO faqs (tenant_id, pregunta, respuesta, canal) VALUES ($1, $2, $3, $4)',
        [tenant_id, item.pregunta, item.respuesta, canal]
      );
    }

    // ✅ Guardar Intents por canal
    await pool.query('DELETE FROM intents WHERE tenant_id = $1 AND canal = $2', [tenant_id, canal]);
    for (const item of intents) {
      await pool.query(
        'INSERT INTO intents (tenant_id, nombre, ejemplos, respuesta, canal) VALUES ($1, $2, $3, $4, $5)',
        [tenant_id, item.nombre, item.ejemplos, item.respuesta, canal]
      );
    }

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('❌ Error en POST /api/settings:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ✅ PUT: Actualizar perfil de negocio + faqs e intents por canal
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
      logo_url,
      prompt_meta,
      bienvenida_meta,
      facebook_page_id,
      facebook_page_name,
      facebook_access_token,
      instagram_page_id,
      instagram_page_name,
      instagram_business_account_id,
      email_negocio, // 🆕 Nuevo campo
      telefono_negocio, // 🆕 Nuevo campo
      faq = [],
      intents = [],
      canal = 'whatsapp',
    } = req.body;

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
        mensaje_bienvenida = $7,
        informacion_negocio = $8,
        funciones_asistente = $9,
        info_clave = $10,
        logo_url = $11,
        prompt_meta = $12,
        bienvenida_meta = $13,
        facebook_page_id = $14,
        facebook_page_name = $15,
        facebook_access_token = $16,
        instagram_page_id = $17,
        instagram_page_name = $18,
        instagram_business_account_id = $19,
        email_negocio = $20, -- 🆕 Nuevo campo
        telefono_negocio = $21, -- 🆕 Nuevo campo
        onboarding_completado = true
      WHERE id = $22`,
      [
        nombre_negocio || current.name,
        categoria || current.categoria,
        idioma || current.idioma,
        direccion || current.direccion,
        horario_atencion || current.horario_atencion,
        prompt || current.prompt,
        bienvenida || current.mensaje_bienvenida,
        informacion_negocio || current.informacion_negocio,
        funciones_asistente || current.funciones_asistente,
        info_clave || current.info_clave,
        logo_url || current.logo_url,
        prompt_meta || current.prompt_meta,
        bienvenida_meta || current.bienvenida_meta,
        typeof facebook_page_id !== 'undefined' ? facebook_page_id : current.facebook_page_id,
        typeof facebook_page_name !== 'undefined' ? facebook_page_name : current.facebook_page_name,
        typeof facebook_access_token !== 'undefined' ? facebook_access_token : current.facebook_access_token,
        typeof instagram_page_id !== 'undefined' ? instagram_page_id : current.instagram_page_id,
        typeof instagram_page_name !== 'undefined' ? instagram_page_name : current.instagram_page_name,
        typeof instagram_business_account_id !== 'undefined' ? instagram_business_account_id : current.instagram_business_account_id,
        email_negocio || current.email_negocio, // 🆕 Nuevo campo
        telefono_negocio || current.telefono_negocio, // 🆕 Nuevo campo
        tenant_id,
      ]
    );
    
    // ✅ Reemplazar faqs e intents del canal actual
    await pool.query('DELETE FROM faqs WHERE tenant_id = $1 AND canal = $2', [tenant_id, canal]);
    for (const item of faq) {
      await pool.query(
        'INSERT INTO faqs (tenant_id, pregunta, respuesta, canal) VALUES ($1, $2, $3, $4)',
        [tenant_id, item.pregunta, item.respuesta, canal]
      );
    }

    await pool.query('DELETE FROM intents WHERE tenant_id = $1 AND canal = $2', [tenant_id, canal]);
    for (const item of intents) {
      await pool.query(
        'INSERT INTO intents (tenant_id, nombre, ejemplos, respuesta, canal) VALUES ($1, $2, $3, $4, $5)',
        [tenant_id, item.nombre, item.ejemplos, item.respuesta, canal]
      );
    }

    return res.status(200).json({ message: 'Perfil actualizado correctamente' });
  } catch (error) {
    console.error('❌ Error en PUT /api/settings:', error);
    return res.status(500).json({ error: 'Error al guardar cambios' });
  }
});

export default router;
