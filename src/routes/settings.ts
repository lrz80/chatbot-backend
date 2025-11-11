// src/routes/settings.ts

import express from 'express';
import { Request, Response } from 'express';
import pool from '../lib/db';
import { authenticateUser } from '../middleware/auth';

const router = express.Router();

/** Valida URLs http(s) sencillas */
function isValidUrl(u?: string) {
  try {
    if (!u) return false;
    if (!/^https?:\/\//i.test(u)) return false;
    new URL(u);
    return true;
  } catch {
    return false;
  }
}

// ✅ GET: Perfil del negocio + FAQs + Intents + CTA global (desde tenant_ctas)
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

    // ✅ Obtener CTA global desde tenant_ctas (intent='global')
    const ctaRes = await pool.query(
      'SELECT cta_text, cta_url FROM tenant_ctas WHERE tenant_id = $1 AND intent = $2 LIMIT 1',
      [tenant_id, 'global']
    );
    const cta = ctaRes.rows[0] || { cta_text: '', cta_url: '' };

    const canales = ['contactos', 'whatsapp', 'sms', 'email', 'voz', 'meta', 'followup', 'tokens_openai'];
    const limites: any = {};

    for (const c of canales) {
      const baseRes = await pool.query(
        `SELECT limite, usados FROM uso_mensual
         WHERE tenant_id = $1 AND canal = $2 AND mes = date_trunc('month', CURRENT_DATE)`,
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

    // ====================== NUEVO BLOQUE ======================
    const hoy = new Date();
    const vigencia = tenant.membresia_vigencia ? new Date(tenant.membresia_vigencia) : null;

    // Si no usas subscription_id, calcula trial por plan o flag
    const es_trial = Boolean(tenant.plan === 'trial' || tenant.es_trial === true);

    // trial vigente si es trial y no ha vencido
    const trial_vigente = Boolean(es_trial && vigencia && vigencia >= hoy);

    // puede editar si plan activo o trial vigente
    const can_edit = Boolean(tenant.membresia_activa || trial_vigente);

    // Texto UI
    let estado_membresia_texto = '🔴 Inactiva';
    if (tenant.membresia_activa) {
      const f = vigencia ? vigencia.toLocaleDateString() : '';
      estado_membresia_texto = `✅ Activa - Plan ${tenant.plan || 'Pro'} hasta ${f}`;
    } else if (trial_vigente) {
      const f = vigencia ? vigencia.toLocaleDateString() : '';
      estado_membresia_texto = `🟡 Prueba gratis activa hasta ${f}`;
    } else if (es_trial && vigencia && vigencia < hoy) {
      const f = vigencia.toLocaleDateString();
      estado_membresia_texto = `🔴 Prueba gratis vencida el ${f}`;
    }

    // Aliases que el front espera
    const plan_name: string | null = tenant.plan ?? null;
    const plan: string | null = plan_name;                // 👈 alias usado por el front
    const registered_at: string | null = tenant.created_at ?? null;
    const fecha_registro: string | null = registered_at;  // 👈 alias usado por el front

    return res.status(200).json({
      uid: user.uid,
      email: user.email,
      owner_name: user.owner_name,
      tenant_id,

      // Membresía / trial
      membresia_activa: Boolean(tenant.membresia_activa),
      membresia_vigencia: tenant.membresia_vigencia ?? null,
      es_trial,                  // 👈 ya sin subscription_id
      trial_vigente,            // 👈 expuesto
      can_edit,                 // 👈 expuesto
      estado_membresia_texto,

      // Perfil negocio
      onboarding_completado: tenant.onboarding_completado,
      name: tenant.name || '',
      categoria: tenant.categoria || '',
      idioma: tenant.idioma || 'es',
      prompt: tenant.prompt || '',
      bienvenida: tenant.mensaje_bienvenida || '',
      informacion_negocio: tenant.informacion_negocio || '',
      funciones_asistente: tenant.funciones_asistente || '',
      info_clave: tenant.info_clave || '',
      logo_url: tenant.logo_url || '',
      email_negocio: tenant.email_negocio || '',
      telefono_negocio: tenant.telefono_negocio || '',
      direccion: tenant.direccion || '',

      // Twilio
      twilio_number: tenant.twilio_number || null,
      twilio_sms_number: tenant.twilio_sms_number || null,
      twilio_voice_number: tenant.twilio_voice_number || null,

      // Plan / fechas (con aliases para el front)
      plan_name,
      plan,                // 👈 tu front lee formData.plan
      registered_at,
      fecha_registro,      // 👈 tu front lee formData.fecha_registro

      // Datos de entrenamiento
      faq: faqsRes.rows,
      intents: intentsRes.rows,

      // Límites + CTA global
      limites,
      cta_text: cta.cta_text || '',
      cta_url: cta.cta_url || '',
    });
    // ==================== FIN NUEVO BLOQUE ====================

  } catch (error) {
    console.error('❌ Error en GET /api/settings:', error);
    return res.status(401).json({ error: 'Token inválido' });
  }
});

// ✅ PATCH: guarda o actualiza el CTA global en tenant_ctas
router.patch('/', authenticateUser, async (req: any, res: Response) => {
  try {
    const tenant_id = req.user?.tenant_id;
    if (!tenant_id) return res.status(401).json({ error: 'Tenant no autenticado' });

    const { cta_text, cta_url, ...body } = req.body;

    // 🔹 Guardar/actualizar CTA global (intent = 'global')
    if (cta_text !== undefined || cta_url !== undefined) {
      const cleanText = (cta_text ?? '').trim();
      const cleanUrl = (cta_url ?? '').trim();

      if (cleanUrl && !isValidUrl(cleanUrl)) {
        return res.status(400).json({ error: 'cta_url inválida. Debe iniciar con http(s)://' });
      }

      await pool.query(
        `INSERT INTO tenant_ctas (tenant_id, intent, cta_text, cta_url)
         VALUES ($1, 'global', $2, $3)
         ON CONFLICT (tenant_id, intent)
         DO UPDATE SET
           cta_text = EXCLUDED.cta_text,
           cta_url  = EXCLUDED.cta_url,
           updated_at = NOW()`,
        [tenant_id, cleanText || null, cleanUrl || null]
      );
    }

    // 🔹 Actualizar otros campos del tenant
    const allowed = new Set([
      'nombre_negocio', 'categoria', 'idioma', 'prompt', 'bienvenida',
      'informacion_negocio', 'funciones_asistente', 'info_clave', 'logo_url',
      'prompt_meta', 'bienvenida_meta', 'facebook_page_id', 'facebook_page_name',
      'facebook_access_token', 'instagram_page_id', 'instagram_page_name',
      'instagram_business_account_id', 'email_negocio', 'telefono_negocio',
      'direccion',                 // ⬅️ agregar
      'horario_atencion',          // ⬅️ si tienes esa columna
    ]);

    const mapCol: Record<string, string> = {
      nombre_negocio: 'name',
      categoria: 'categoria',
      idioma: 'idioma',
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
      direccion: 'direccion',                   // ⬅️ agregar
      horario_atencion: 'horario_atencion',     // ⬅️ si existe
    };

    const sets: string[] = [];
    const values: any[] = [];

    for (const [k, v] of Object.entries(body)) {
      if (!allowed.has(k)) continue;
      if (v === undefined || v === null) continue;
      const val = typeof v === 'string' ? v.trim() : v;
      if (typeof val === 'string' && val === '') continue;
      sets.push(`${mapCol[k]} = $${sets.length + 1}`);
      values.push(val);
    }

    if (sets.length) {
      sets.push(`updated_at = NOW()`);
      const sql = `UPDATE tenants SET ${sets.join(', ')} WHERE id = $${values.length + 1}`;
      values.push(tenant_id);
      await pool.query(sql, values);
    }

    return res.json({ ok: true });

  } catch (e) {
    console.error('❌ PATCH /api/settings error', e);
    return res.status(500).json({ error: 'Error al actualizar settings' });
  }
});

router.post('/', authenticateUser, async (req, res) => {
  (router as any).handle({ ...req, method: 'PATCH' }, res);
});

export default router;
