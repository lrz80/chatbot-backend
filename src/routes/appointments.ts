// src/routes/appointments.ts
import express, { Request, Response } from "express";
import pool from "../lib/db";
import { authenticateUser } from "../middleware/auth";
import axios from "axios";
import { enviarMensajePorPartes } from "../lib/enviarMensajePorPartes";
import { getAppointmentSettings, updateAppointmentSettings } from "../lib/appointments/booking/db";


const router = express.Router();

/**
 * GET /api/appointments
 * Lista las citas del tenant autenticado (últimas 50, ordenadas por fecha).
 */
router.get(
  "/",
  authenticateUser,
  async (req, res) => {
    try {
      const tenantId = req.user?.tenant_id;
      if (!tenantId)
        return res.status(401).json({ ok: false, error: "TENANT_NOT_FOUND_IN_TOKEN" });

      // Filtros opcionales
      const {
        canal,
        estado,
        cliente,
        telefono,
        desde,
        hasta,
      } = req.query;

      const where = [`x.tenant_id = $1`];
      const params: any[] = [tenantId];
      let idx = 2;

      if (canal) {
        const c = String(Array.isArray(canal) ? canal[0] : canal).trim().toLowerCase();
        where.push(`LOWER(x.channel) = $${idx++}`);
        params.push(c);
      }

      if (estado) {
        const raw = String(Array.isArray(estado) ? estado[0] : estado).trim().toLowerCase();

        const map: Record<string, string> = {
          pendiente: "pending",
          confirmada: "confirmed",
          cancelada: "cancelled",
          atendida: "attended",
          scheduled: "scheduled",

          pending: "pending",
          confirmed: "confirmed",
          cancelled: "cancelled",
          attended: "attended",
        };

        const s = map[raw];
        if (s) {
          where.push(`x.status = $${idx++}`);
          params.push(s);
        }
      }

      if (cliente) {
        const q = String(Array.isArray(cliente) ? cliente[0] : cliente).trim();
        where.push(`x.customer_name ILIKE $${idx++}`);
        params.push(`%${q}%`);
      }

      if (telefono) {
        const q = String(Array.isArray(telefono) ? telefono[0] : telefono).trim();
        where.push(`x.customer_phone ILIKE $${idx++}`);
        params.push(`%${q}%`);
      }

      if (desde) {
        where.push(`x.start_time >= $${idx++}`);
        params.push(desde);
      }

      if (hasta) {
        where.push(`x.start_time <= $${idx++}`);
        params.push(hasta);
      }

      const whereSQL = where.length ? `WHERE ${where.join(" AND ")}` : "";

      const query = `
        SELECT *
        FROM (
          SELECT
            a.id::text AS id,
            a.tenant_id,
            a.service_id,
            s.name AS service_name,
            a.channel,
            a.customer_name,
            a.customer_phone,
            a.customer_email,
            a.start_time,
            a.end_time,
            a.status,
            a.created_at,
            a.updated_at,
            'appointment'::text AS source
          FROM appointments a
          LEFT JOIN services s ON s.id = a.service_id

          UNION ALL

          SELECT
            er.id::text AS id,
            er.tenant_id,
            NULL::uuid AS service_id,
            er.tipo_trabajo AS service_name,
            er.canal AS channel,
            er.nombre AS customer_name,
            er.telefono AS customer_phone,
            NULL::text AS customer_email,
            er.scheduled_start_at AS start_time,
            er.scheduled_end_at AS end_time,
            CASE
              WHEN er.status = 'scheduled' THEN 'confirmed'
              ELSE er.status
            END AS status,
            er.created_at,
            er.created_at AS updated_at,
            'estimate_request'::text AS source
          FROM estimate_requests er
        ) x
        ${whereSQL}
        ORDER BY
          (x.start_time < NOW()) ASC,
          x.start_time ASC
        LIMIT 200
      `;

      const { rows } = await pool.query(query, params);

      return res.json({ ok: true, appointments: rows });

    } catch (e) {
      console.error("GET /appointments error:", e);
      return res.status(500).json({ ok: false, error: "INTERNAL_SERVER_ERROR" });
    }
  }
);

/**
 * PUT /api/appointments/:id/status
 * Actualiza el estado de una cita del tenant autenticado.
 * Estados permitidos: pending | confirmed | cancelled | attended
 */
router.put(
  "/:id/status",
  authenticateUser,
  async (
    req: Request & {
      user?: { uid: string; tenant_id: string; email?: string };
    },
    res: Response
  ) => {
    try {
      const user = req.user;

      if (!user?.tenant_id) {
        return res.status(401).json({
          ok: false,
          error: "TENANT_NOT_FOUND_IN_TOKEN",
        });
      }

      const tenantId = user.tenant_id;
      const { id } = req.params;
      const { status } = req.body as { status?: string };

      const allowed = ["pending", "confirmed", "cancelled", "attended"];

      if (!status || !allowed.includes(status)) {
        return res.status(400).json({
          ok: false,
          error: "INVALID_STATUS",
          allowed,
        });
      }

            let appt: any = null;

      // 1) intentar actualizar cita normal
      {
        const { rows } = await pool.query(
          `
          UPDATE appointments
          SET status = $1, updated_at = NOW()
          WHERE id = $2 AND tenant_id = $3
          RETURNING
            id,
            tenant_id,
            service_id,
            channel,
            customer_name,
            customer_phone,
            customer_email,
            start_time,
            end_time,
            status,
            created_at,
            updated_at,
            google_event_id,
            google_event_link,
            'appointment'::text AS source
          `,
          [status, id, tenantId]
        );

        if (rows[0]) {
          appt = rows[0];
        }
      }

      // 2) si no era cita normal, intentar estimate_request
      if (!appt) {
        const estimateStatus =
          status === "confirmed"
            ? "scheduled"
            : status;

        const { rows } = await pool.query(
          `
          UPDATE estimate_requests
          SET status = $1
          WHERE id = $2 AND tenant_id = $3
          RETURNING
            id::text AS id,
            tenant_id,
            NULL::uuid AS service_id,
            canal AS channel,
            nombre AS customer_name,
            telefono AS customer_phone,
            NULL::text AS customer_email,
            scheduled_start_at AS start_time,
            scheduled_end_at AS end_time,
            CASE
              WHEN status = 'scheduled' THEN 'confirmed'
              ELSE status
            END AS status,
            created_at,
            created_at AS updated_at,
            calendar_event_id AS google_event_id,
            calendar_event_link AS google_event_link,
            'estimate_request'::text AS source
          `,
          [estimateStatus, id, tenantId]
        );

        if (rows[0]) {
          appt = rows[0];
        }
      }

      if (!appt) {
        return res.status(404).json({
          ok: false,
          error: "APPOINTMENT_NOT_FOUND",
        });
      }

      // ─────────────────────────────────────────────
      // Enviar mensaje al cliente (Cloud API si existe, si no Twilio)
      // ─────────────────────────────────────────────
      try {
        // Solo enviamos si la cita es de canal whatsapp y tenemos teléfono
        if (appt.channel === "whatsapp" && appt.customer_phone) {
            const start = new Date(appt.start_time);
            const fechaLocal = start.toLocaleString("es-ES", {
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            });

            let texto: string | null = null;

            if (status === "confirmed") {
            texto = `✅ Tu cita ha sido *confirmada* para el ${fechaLocal}. Si necesitas cambiar la hora, puedes responder este mensaje.`;
            } else if (status === "cancelled") {
            texto = `⚠️ Tu cita para el ${fechaLocal} ha sido *cancelada*. Si deseas agendar una nueva cita, escríbenos por aquí.`;
            } else if (status === "attended") {
            texto = `🙌 Gracias por asistir a tu cita del ${fechaLocal}. Si necesitas otra cita, puedes escribirnos cuando quieras.`;
            } else if (status === "pending") {
            texto = `📌 Tu cita para el ${fechaLocal} está *pendiente de confirmación*. En breve te confirmaremos el horario definitivo.`;
            }

            if (texto) {
            // 1) Leemos la config de WhatsApp Cloud API del tenant
            const tenantCfg = await pool.query(
                `
                SELECT
                whatsapp_phone_number_id,
                whatsapp_access_token
                FROM tenants
                WHERE id = $1
                `,
                [tenantId]
            );

            const cfg = tenantCfg.rows[0] as
                | {
                    whatsapp_phone_number_id?: string;
                    whatsapp_access_token?: string;
                }
                | undefined;

            // Si el tenant tiene Cloud API configurado, usamos Cloud API
            if (cfg?.whatsapp_phone_number_id && cfg?.whatsapp_access_token) {
                try {
                await axios.post(
                    `https://graph.facebook.com/v21.0/${cfg.whatsapp_phone_number_id}/messages`,
                    {
                    messaging_product: "whatsapp",
                    to: appt.customer_phone, // número del cliente, tal cual lo guardaste
                    type: "text",
                    text: { body: texto },
                    },
                    {
                    headers: {
                        Authorization: `Bearer ${cfg.whatsapp_access_token}`,
                    },
                    }
                );

                console.log(
                    "[APPOINTMENTS] WhatsApp Cloud API enviado correctamente a",
                    appt.customer_phone
                );
                } catch (cloudErr: any) {
                console.error(
                    "[APPOINTMENTS] Error enviando por WhatsApp Cloud API:",
                    cloudErr?.response?.data || cloudErr?.message || cloudErr
                );
                }
            } else {
                // Fallback: Twilio (enviarMensajePorPartes) si no hay Cloud API
                try {
                await enviarMensajePorPartes({
                    tenantId,
                    canal: "whatsapp",
                    senderId: appt.customer_phone, // número del cliente
                    messageId: appt.id,
                    accessToken: "",
                    respuesta: texto,
                });

                console.log(
                    "[APPOINTMENTS] WhatsApp vía Twilio enviado a",
                    appt.customer_phone
                );
              } catch (twilioErr: any) {
                console.error(
                    "[APPOINTMENTS] Error enviando por Twilio:",
                    twilioErr?.response?.data || twilioErr?.message || twilioErr
                );
              }
            }
          }
        }
      } catch (sendErr) {
        console.error(
            "[PUT /api/appointments/:id/status] Error general enviando notificación:",
            (sendErr as any)?.response?.data || (sendErr as any)?.message || sendErr
        );
      }
      return res.json({
        ok: true,
        appointment: appt,
      });
    } catch (error) {
      console.error("[PUT /api/appointments/:id/status] Error:", error);
      return res.status(500).json({
        ok: false,
        error: "INTERNAL_SERVER_ERROR",
      });
    }
  }
);

/**
 * GET /api/appointments/settings
 * Devuelve appointment_settings del tenant autenticado (incluye min_lead_minutes).
 */
router.get(
  "/settings",
  authenticateUser,
  async (
    req: Request & { user?: { uid: string; tenant_id: string; email?: string } },
    res: Response
  ) => {
    try {
      const tenantId = req.user?.tenant_id;
      if (!tenantId) {
        return res.status(401).json({ ok: false, error: "TENANT_NOT_FOUND_IN_TOKEN" });
      }

      const settings = await getAppointmentSettings(tenantId);

      // ✅ Traer cuenta conectada de Google
      const gi = await pool.query(
        `
        SELECT status, connected_email, calendar_id
        FROM calendar_integrations
        WHERE tenant_id = $1 AND provider = 'google'
        LIMIT 1
        `,
        [tenantId]
      );

      const g = gi.rows[0] as
        | { status?: string; connected_email?: string | null; calendar_id?: string | null }
        | undefined;

      return res.json({
        ok: true,
        settings,
        google: {
          status: g?.status ?? "disconnected",
          connected_email: g?.connected_email ?? null,
          calendar_id: g?.calendar_id ?? null,
          connected: (g?.status === "connected"),
        },
      });
    } catch (error) {
      console.error("[GET /api/appointments/settings] Error:", error);
      return res.status(500).json({ ok: false, error: "INTERNAL_SERVER_ERROR" });
    }
  }
);

/**
 * PATCH /api/appointments/settings
 * Actualiza appointment_settings del tenant (minLeadMinutes, durationMin, bufferMin, timeZone, enabled).
 */
router.patch(
  "/settings",
  authenticateUser,
  async (
    req: Request & { user?: { uid: string; tenant_id: string; email?: string } },
    res: Response
  ) => {
    try {
      const tenantId = req.user?.tenant_id;
      if (!tenantId) {
        return res.status(401).json({ ok: false, error: "TENANT_NOT_FOUND_IN_TOKEN" });
      }

      const {
        durationMin,
        bufferMin,
        timeZone,
        enabled,
        minLeadMinutes,
      } = (req.body || {}) as {
        durationMin?: any;
        bufferMin?: any;
        timeZone?: any;
        enabled?: any;
        minLeadMinutes?: any;
      };

      // Validación/normalización mínima (no revientes por NaN)
      const patch: any = {};

      if (durationMin !== undefined) {
        const v = Number(durationMin);
        if (!Number.isFinite(v) || v <= 0) {
          return res.status(400).json({ ok: false, error: "INVALID_durationMin" });
        }
        patch.durationMin = v;
      }

      if (bufferMin !== undefined) {
        const v = Number(bufferMin);
        if (!Number.isFinite(v) || v < 0) {
          return res.status(400).json({ ok: false, error: "INVALID_bufferMin" });
        }
        patch.bufferMin = v;
      }

      if (minLeadMinutes !== undefined) {
        const v = Number(minLeadMinutes);
        if (!Number.isFinite(v) || v < 0) {
          return res.status(400).json({ ok: false, error: "INVALID_minLeadMinutes" });
        }
        patch.minLeadMinutes = v;
      }

      if (timeZone !== undefined) {
        const tz = String(timeZone || "").trim();
        if (!tz) {
          return res.status(400).json({ ok: false, error: "INVALID_timeZone" });
        }
        patch.timeZone = tz;
      }

      if (enabled !== undefined) {
        patch.enabled = !!enabled;
      }

      const settings = await updateAppointmentSettings(tenantId, patch);

      return res.json({ ok: true, settings });
    } catch (error) {
      console.error("[PATCH /api/appointments/settings] Error:", error);
      return res.status(500).json({ ok: false, error: "INTERNAL_SERVER_ERROR" });
    }
  }
);

/**
 * POST /api/appointments/book
 * Crea una cita en DB y (si está habilitado + conectado) también en Google Calendar.
 */
router.post("/book", authenticateUser, async (req, res) => {
  const tenantId = req.user?.tenant_id;
  if (!tenantId) return res.status(401).json({ ok:false, error:"TENANT_NOT_FOUND_IN_TOKEN" });

  const { service_id, channel, customer_name, customer_phone, customer_email, start_time, end_time } = req.body || {};
  if (!customer_name || !start_time || !end_time) {
    return res.status(400).json({ ok:false, error:"MISSING_FIELDS", required:["customer_name","start_time","end_time"] });
  }

  const { rows } = await pool.query(
    `INSERT INTO appointments (
        tenant_id, service_id, channel, customer_name, customer_phone, customer_email,
        start_time, end_time, status, google_event_id, google_event_link
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',NULL,NULL)
     RETURNING *`,
    [tenantId, service_id || null, channel || "manual", customer_name, customer_phone || null, customer_email || null, start_time, end_time]
  );

  return res.json({ ok:true, appointment: rows[0] });
});

export default router;
