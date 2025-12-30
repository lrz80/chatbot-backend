// src/routes/settings.ts

import express from 'express';
import { Request, Response } from 'express';
import pool from '../lib/db';
import { authenticateUser } from '../middleware/auth';

const router = express.Router();
const normalizeEmail = (e?: string | null) => (e || '').trim().toLowerCase();

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

    // ¿Este email ya tomó trial alguna vez? (registro permanente por email)
    const usedByEmailRes = await pool.query(
      `SELECT 1 FROM trial_registry WHERE email_normalized = $1 LIMIT 1`,
      [normalizeEmail(user.email)]
    );
    const trial_usado_por_email = !!usedByEmailRes.rows[0];

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

    // ➕ Flags de canales que incluye el plan actual (se llenan en el webhook de Stripe)
    const chRes = await pool.query(
      `SELECT
          whatsapp_enabled,
          meta_enabled,
          voice_enabled,
          sms_enabled,
          email_enabled,
          facebook_enabled,
          instagram_enabled
      FROM channel_settings
      WHERE tenant_id = $1
      LIMIT 1`,
      [tenant_id]
    );
    const ch = chRes.rows[0] || {};

    const channel_flags = {
      whatsapp: !!ch?.whatsapp_enabled,
      meta:     !!ch?.meta_enabled,
      voice:    !!ch?.voice_enabled,
      sms:      !!ch?.sms_enabled,
      email:    !!ch?.email_enabled,
    };

    const meta_subchannel_flags = {
      facebook: ch?.facebook_enabled !== false,   // null/true => ON
      instagram: ch?.instagram_enabled !== false, // null/true => ON
    };

    // Conveniencias: ¿puede editar/usar por canal? (plan lo incluye + plan activo o trial)
    const plan_activo_o_trial = Boolean(
      tenant.membresia_activa ||
      (tenant.es_trial && tenant.membresia_vigencia && new Date(tenant.membresia_vigencia) >= new Date())
    );
    const can_edit_by_channel = {
      whatsapp: channel_flags.whatsapp && plan_activo_o_trial,
      meta:     channel_flags.meta     && plan_activo_o_trial,
      voice:    channel_flags.voice    && plan_activo_o_trial,
      sms:      channel_flags.sms      && plan_activo_o_trial,
      email:    channel_flags.email    && plan_activo_o_trial,
    };

    // ====================== BLOQUE MEMBRESÍA / TRIAL ======================
    const hoy = new Date();
    const vigencia = tenant.membresia_vigencia ? new Date(tenant.membresia_vigencia) : null;

    const es_trial = tenant.es_trial === true;
    const trial_activo = Boolean(es_trial && vigencia && vigencia >= hoy);

    // Trial disponible SOLO si:
    //  - NUNCA lo usó por email (trial_registry)
    //  - y además no tiene plan activo ni trial activo
    const trial_disponible = Boolean(
      !trial_usado_por_email &&
      !tenant.trial_ever_claimed &&
      !tenant.membresia_activa &&
      !trial_activo
    );

    // Puede editar si plan activo o trial activo
    const can_edit = Boolean(tenant.membresia_activa || trial_activo);

    // Texto UI (prioriza trial aunque membresía_activa sea true)
    let estado_membresia_texto = '🔴 Inactiva';
    if (trial_activo) {
      const f = vigencia ? vigencia.toLocaleDateString() : '';
      estado_membresia_texto = `🟡 Período de prueba activo hasta ${f}`;
    } else if (tenant.membresia_activa) {
      const f = vigencia ? vigencia.toLocaleDateString() : '';
      const planLegible = (tenant.plan || 'Pro').replace(/^\w/, (c: string) => c.toUpperCase());
      estado_membresia_texto = `✅ Activa - Plan ${planLegible} hasta ${f}`;
    } else if (tenant.trial_ever_claimed) {
      estado_membresia_texto = '🔴 Período de prueba vencido.';
    }

    // Aliases esperados por el front
    const plan_name: string | null = tenant.plan ?? null;
    const plan: string | null = plan_name;
    const registered_at: string | null = tenant.created_at ?? null;
    const fecha_registro: string | null = registered_at;
    // ==================== FIN BLOQUE ====================

    return res.status(200).json({
      uid: user.uid,
      email: user.email,
      owner_name: user.owner_name,
      tenant_id,

      // Membresía / trial
      membresia_activa: Boolean(tenant.membresia_activa),
      membresia_vigencia: tenant.membresia_vigencia ?? null,
      es_trial,
      trial_activo,                  // ✅ nombre real calculado arriba
      trial_vigente: trial_activo,   // ✅ alias, por compatibilidad con el front
      trial_disponible,              // ✅ para CTA de “prueba gratis” (redirige a /upgrade)
      trial_ever_claimed: Boolean(tenant.trial_ever_claimed), // ✅ viene de DB
      can_edit,
      estado_membresia_texto,

      // Plan / fechas
      plan_name,
      plan,
      registered_at,
      fecha_registro,

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
      horario_atencion: tenant.horario_atencion || '',
      // WhatsApp (control de canal + proveedor activo)
      whatsapp_status: tenant.whatsapp_status ?? 'disconnected', // 'enabled' | 'disabled'
      whatsapp_mode: tenant.whatsapp_mode ?? 'twilio',       // 'twilio' | 'cloudapi'

      // Cloud API
      whatsapp_connected: Boolean(tenant.whatsapp_connected),
      whatsapp_phone_number_id: tenant.whatsapp_phone_number_id ?? null,
      whatsapp_phone_number: tenant.whatsapp_phone_number ?? null,

      // ✅ Twilio WhatsApp Sender SID (para UI)
      whatsapp_sender_sid: tenant.whatsapp_sender_sid ?? null,

      // Conveniencias para UI (conectado por proveedor)
      whatsapp_cloud_connected: Boolean(tenant.whatsapp_connected && tenant.whatsapp_phone_number_id),
      whatsapp_twilio_connected: Boolean(tenant.twilio_number),


      // Twilio
      twilio_number: tenant.twilio_number || null,
      twilio_subaccount_sid: tenant.twilio_subaccount_sid ?? null,
      twilio_sms_number: tenant.twilio_sms_number || null,
      twilio_voice_number: tenant.twilio_voice_number || null,

      // Datos de entrenamiento
      faq: faqsRes.rows,
      intents: intentsRes.rows,

      // Límites + CTA global
      limites,
      cta_text: cta.cta_text || '',
      cta_url: cta.cta_url || '',

      // Flags de canales incluidos y permisos por canal
      channel_flags,
      can_edit_by_channel,

      meta_subchannel_flags,
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

    // ✅ Meta subchannels (silencio total): facebook_enabled / instagram_enabled
    // Se guardan en channel_settings (no en tenants)
    const metaSubUpdates: Record<string, boolean> = {};

    if (body.facebook_enabled !== undefined) {
      metaSubUpdates.facebook_enabled = Boolean(body.facebook_enabled);
      delete (body as any).facebook_enabled;
    }

    if (body.instagram_enabled !== undefined) {
      metaSubUpdates.instagram_enabled = Boolean(body.instagram_enabled);
      delete (body as any).instagram_enabled;
    }

    // Aplica update si hay algo
    if (Object.keys(metaSubUpdates).length) {
      // Asegura que exista fila en channel_settings
      await pool.query(
        `INSERT INTO channel_settings (tenant_id)
        VALUES ($1)
        ON CONFLICT (tenant_id) DO NOTHING`,
        [tenant_id]
      );

      const sets: string[] = [];
      const vals: any[] = [];

      for (const [k, v] of Object.entries(metaSubUpdates)) {
        sets.push(`${k} = $${sets.length + 1}`);
        vals.push(v);
      }

      // opcional: updated_at si existe en esa tabla; si no existe, quítalo
      sets.push(`updated_at = NOW()`);

      await pool.query(
        `UPDATE channel_settings
            SET ${sets.join(', ')}
          WHERE tenant_id = $${vals.length + 1}`,
        [...vals, tenant_id]
      );
    }

    // ✅ Validación WhatsApp
    if (body.whatsapp_mode !== undefined) {
      const v = String(body.whatsapp_mode).trim().toLowerCase();
      if (!['twilio', 'cloudapi'].includes(v)) {
        return res.status(400).json({ error: "whatsapp_mode inválido. Use 'twilio' o 'cloudapi'." });
      }
      body.whatsapp_mode = v;
    }

    if (body.whatsapp_status !== undefined) {
      const v = String(body.whatsapp_status).trim().toLowerCase();
      if (!['disconnected', 'pending', 'connected'].includes(v)) {
        return res.status(400).json({
          error: "whatsapp_status inválido. Use 'disconnected', 'pending' o 'connected'.",
        });
      }
      body.whatsapp_status = v;
    }

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
      'direccion',
      'horario_atencion',

      // ✅ WhatsApp provider + estado del canal
      'whatsapp_mode',
      'whatsapp_status',
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
      // ✅ WhatsApp provider + estado del canal
      whatsapp_mode: 'whatsapp_mode',
      whatsapp_status: 'whatsapp_status',
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
