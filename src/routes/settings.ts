// src/routes/settings.ts

import express from 'express';
import { Request, Response } from 'express';
import pool from '../lib/db';
import { authenticateUser } from '../middleware/auth';

const router = express.Router();

// ✅ GET: Perfil del negocio + FAQs e Intents por canal + Límite por canal (base + créditos extra)
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

    const tenantRes = await pool.query(`SELECT * FROM tenants WHERE id = $1 LIMIT 1`, [tenant_id]);
    const tenant = tenantRes.rows[0];
    if (!tenant) return res.status(404).json({ error: 'Tenant no encontrado' });

    const canal = req.query.canal || 'whatsapp';

    const faqsRes = await pool.query(
      'SELECT id, pregunta, respuesta FROM faqs WHERE tenant_id = $1 AND canal = $2 ORDER BY id',
      [tenant_id, canal]
    );
    const intentsRes = await pool.query(
      'SELECT id, nombre, ejemplos, respuesta FROM intents WHERE tenant_id = $1 AND canal = $2 ORDER BY id',
      [tenant_id, canal]
    );

    const canales = ['contactos', 'whatsapp', 'sms', 'email', 'voz', 'meta', 'followup', 'tokens_openai'];
    const limites: any = {};

    for (const c of canales) {
      const baseRes = await pool.query(
        `SELECT limite, usados FROM uso_mensual WHERE tenant_id = $1 AND canal = $2 AND mes = date_trunc('month', CURRENT_DATE)`,
        [tenant_id, c]
      );
      const base = baseRes.rows[0] || { limite: 0, usados: 0 };

      const extraRes = await pool.query(
        `SELECT COALESCE(SUM(cantidad), 0) AS extras
         FROM creditos_comprados
         WHERE tenant_id = $1 AND canal = $2 AND fecha_vencimiento > NOW()`,
        [tenant_id, c]
      );
      const extras = parseInt(extraRes.rows[0]?.extras || 0, 10);

      limites[c] = {
        limite_base: base.limite,
        usados: base.usados,
        creditos_extras: extras,
        total_disponible: base.limite + extras - base.usados,
      };
    }

    const es_trial = tenant.subscription_id?.startsWith('trial_') || tenant.es_trial;

    let estado_membresia_texto = '🔴 Inactiva';
    if (tenant.membresia_activa) {
      if (es_trial) {
        const fechaVigencia = tenant.membresia_vigencia
          ? new Date(tenant.membresia_vigencia).toLocaleDateString()
          : '';
        estado_membresia_texto = `🟡 Activa - Período de Prueba hasta ${fechaVigencia}`;
      } else {
        const fechaVigencia = tenant.membresia_vigencia
          ? new Date(tenant.membresia_vigencia).toLocaleDateString()
          : '';
        estado_membresia_texto = `✅ Activa - Plan Pro hasta ${fechaVigencia}`;
      }
    }

    return res.status(200).json({
      uid: user.uid,
      email: user.email,
      owner_name: user.owner_name,
      tenant_id,
      membresia_activa: tenant.membresia_activa ?? false,
      membresia_vigencia: tenant.membresia_vigencia ?? null,
      es_trial: (es_trial || tenant.es_trial) ?? false,
      estado_membresia_texto,  // ✅ Nuevo campo dinámico
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
      facebook_page_id: tenant.facebook_page_id || '',
      facebook_page_name: tenant.facebook_page_name || '',
      facebook_access_token: tenant.facebook_access_token || '',
      instagram_page_id: tenant.instagram_page_id || '',
      instagram_page_name: tenant.instagram_page_name || '',
      faq: faqsRes.rows,
      intents: intentsRes.rows,
      limites,
    });

  } catch (error) {
    console.error('❌ Error en GET /api/settings:', error);
    return res.status(401).json({ error: 'Token inválido' });
  }
});

router.patch('/', authenticateUser, async (req: any, res: Response) => {
  try {
    const tenant_id = req.user?.tenant_id;
    if (!tenant_id) return res.status(401).json({ error: 'Tenant no autenticado' });

    // Campos que SÍ se pueden actualizar desde /api/settings
    const allowed = new Set([
      'nombre_negocio',        // -> tenants.name
      'categoria',
      'idioma',
      'direccion',
      'horario_atencion',
      'prompt',
      'bienvenida',            // -> tenants.mensaje_bienvenida
      'informacion_negocio',
      'funciones_asistente',
      'info_clave',
      'logo_url',
      'prompt_meta',
      'bienvenida_meta',
      'facebook_page_id',
      'facebook_page_name',
      'facebook_access_token',
      'instagram_page_id',
      'instagram_page_name',
      'instagram_business_account_id',
      'email_negocio',
      'telefono_negocio',
    ]);

    // 🚫 Ignora por completo faqs/intents/canal si llegan en el body
    // (se manejan en /api/faqs y /api/intents)
    const body = { ...req.body };
    delete body.faq;
    delete body.intents;
    delete body.canal;

    // Trae el registro actual para tener defaults
    const curRes = await pool.query('SELECT * FROM tenants WHERE id = $1 LIMIT 1', [tenant_id]);
    const cur = curRes.rows[0];
    if (!cur) return res.status(404).json({ error: 'Tenant no encontrado' });

    // Mapea nombres de payload -> columnas reales
    const mapCol: Record<string, string> = {
      nombre_negocio: 'name',
      categoria: 'categoria',
      idioma: 'idioma',
      direccion: 'direccion',
      horario_atencion: 'horario_atencion',
      prompt: 'prompt',
      bienvenida: 'mensaje_bienvenida',
      informacion_negocio: 'informacion_negocio',
      funciones_asistente: 'funciones_asistente',
      info_clave: 'info_clave',
      logo_url: 'logo_url',
      prompt_meta: 'prompt_meta',
      bienvenida_meta: 'bienvenida_meta',
      facebook_page_id: 'facebook_page_id',
      facebook_page_name: 'facebook_page_name',
      facebook_access_token: 'facebook_access_token',
      instagram_page_id: 'instagram_page_id',
      instagram_page_name: 'instagram_page_name',
      instagram_business_account_id: 'instagram_business_account_id',
      email_negocio: 'email_negocio',
      telefono_negocio: 'telefono_negocio',
    };

    // Construye UPDATE selectivo: solo claves permitidas y con valor "no vacío"
    const sets: string[] = [];
    const values: any[] = [];

    for (const [k, v] of Object.entries(body)) {
      if (!allowed.has(k)) continue;
      if (v === undefined || v === null) continue;
      const val = typeof v === 'string' ? v.trim() : v;
      if (typeof val === 'string' && val === '') continue; // no pisar con string vacío

      const col = mapCol[k];
      sets.push(`${col} = $${sets.length + 1}`);
      values.push(val);
    }

    if (!sets.length) {
      // nada que actualizar (y NO tocamos faqs/intents)
      return res.json({ ok: true, updated: 0 });
    }

    sets.push(`updated_at = NOW()`);
    const sql = `UPDATE tenants SET ${sets.join(', ')} WHERE id = $${values.length + 1}`;
    values.push(tenant_id);

    await pool.query(sql, values);
    return res.json({ ok: true, updated: sets.length - 1 });
  } catch (e) {
    console.error('❌ PATCH /api/settings error', e);
    return res.status(500).json({ error: 'Error al actualizar settings' });
  }
});

// (opcional) Mantén POST por compatibilidad, apuntando al mismo handler seguro
router.post('/', authenticateUser, async (req, res) => {
  // delega al PATCH para la misma lógica
  (router as any).handle({ ...req, method: 'PATCH' }, res);
});

export default router;
