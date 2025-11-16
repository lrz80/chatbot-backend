// src/routes/twilioEmbedded.ts
import { Router } from 'express';
import twilio from 'twilio';
import pool from '../lib/db';             // AJUSTA SI TU DB ESTÁ EN OTRA RUTA
import { authenticateUser } from '../middleware/auth'; 

const router = Router();

// Cliente Twilio maestro
const masterClient = twilio(
  process.env.TWILIO_ACCOUNT_SID!,
  process.env.TWILIO_AUTH_TOKEN!
);

/**
 * 1) Iniciar Embedded Signup:
 *    - Crea la subcuenta Twilio para el tenant si no existe
 *    - Devuelve el link de Twilio Embedded Signup para ese tenant
 */
router.post(
  '/api/twilio/whatsapp/start-embedded-signup',
  authenticateUser,
  async (req, res) => {
  try {
    const tenantId = (req as any).user?.tenant_id;

    if (!tenantId) {
    return res.status(401).json({ error: 'Tenant no encontrado en req.user' });
    }

    const { rows } = await pool.query(
    `SELECT *
        FROM tenants
        WHERE id = $1
        LIMIT 1`,
    [tenantId]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Tenant no encontrado' });
    }

    const tenant = rows[0];
    let subaccountSid = tenant.twilio_subaccount_sid;

    // Crear subcuenta Twilio si no existe
    if (!subaccountSid) {
      const sub = await masterClient.api.accounts.create({
        friendlyName: `Tenant ${tenant.id} - ${tenant.name || ''}`
      });

      subaccountSid = sub.sid;

      await pool.query(
        `UPDATE tenants
            SET twilio_subaccount_sid = $1
          WHERE id = $2`,
        [subaccountSid, tenant.id]
      );
    }

    // Verificar que tengas la URL de Embedded Signup en .env
    const base = process.env.TWILIO_WHATSAPP_EMBEDDED_SIGNUP_URL;
    if (!base) {
      return res.status(500).json({ error: 'Falta TWILIO_WHATSAPP_EMBEDDED_SIGNUP_URL en .env' });
    }

    // URL donde Twilio redirige al cliente al terminar el proceso
    const redirectUrl = encodeURIComponent('https://www.aamy.ai/dashboard/whatsapp-connected');

    // Twilio = signupUrl + subcuenta + redirectUrl
    const signupUrl = `${base}?customerAccountSid=${subaccountSid}&redirectUrl=${redirectUrl}`;

    return res.json({ signupUrl });

  } catch (err) {
    console.error('Error en start-embedded-signup:', err);
    return res.status(500).json({ error: 'Error iniciando proceso de WhatsApp' });
  }
});


/**
 * 2) Sincronizar sender de WhatsApp:
 *    - Se llama después que el cliente completa el proceso en Twilio
 *    - Obtiene número de WhatsApp y sender SID
 *    - Lo guarda en tenants
 */
router.post(
  '/api/twilio/whatsapp/sync-sender',
  authenticateUser,
  async (req, res) => {
  try {
    const tenantId = (req as any).user?.tenant_id;

    if (!tenantId) {
    return res.status(401).json({ error: 'Tenant no encontrado en req.user' });
    }

    const { rows } = await pool.query(
    `SELECT *
        FROM tenants
        WHERE id = $1
        LIMIT 1`,
    [tenantId]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Tenant no encontrado' });
    }

    const tenant = rows[0];

    if (!tenant.twilio_subaccount_sid) {
      return res.status(400).json({ error: 'El tenant no tiene subcuenta Twilio' });
    }

    // Cliente Twilio de la subcuenta
    const subClient = twilio(
      tenant.twilio_subaccount_sid,
      process.env.TWILIO_AUTH_TOKEN!
    );

    // Obtener los senders de WhatsApp en esa subcuenta
    const senders = await (subClient as any).messaging.v1.whatsapp.senders.list({ limit: 20 });

    // Buscar sender aprobado
    const approved = senders.find(
      (s: any) => s.status === 'APPROVED' || s.status === 'ACTIVE'
    );

    if (!approved) {
      await pool.query(
        `UPDATE tenants
            SET whatsapp_status = 'pending'
          WHERE id = $1`,
        [tenant.id]
      );
      return res.json({ status: 'pending', senders });
    }

    // Guardar datos definitivos
    await pool.query(
      `UPDATE tenants
          SET whatsapp_status = 'approved',
              whatsapp_sender_sid = $1,
              twilio_number = $2,
              whatsapp_mode = 'client_waba'
        WHERE id = $3`,
      [approved.sid, approved.phoneNumber.replace('whatsapp:', ''), tenant.id]
    );

    return res.json({
      status: 'approved',
      whatsapp_sender_sid: approved.sid,
      twilio_number: approved.phoneNumber
    });

  } catch (err) {
    console.error('Error en sync-sender:', err);
    return res.status(500).json({ error: 'Error sincronizando sender' });
  }
});

export default router;
