// src/routes/appointments.ts
import express, { Request, Response } from "express";
import pool from "../lib/db";
import { authenticateUser } from "../middleware/auth";
import axios from "axios";
import { enviarMensajePorPartes } from "../lib/enviarMensajePorPartes";

const router = express.Router();

/**
 * GET /api/appointments
 * Lista las citas del tenant autenticado (últimas 50, ordenadas por fecha).
 */
router.get(
  "/",
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

      const { rows } = await pool.query(
        `
        SELECT
          a.id,
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
          a.updated_at
        FROM appointments a
        LEFT JOIN services s ON s.id = a.service_id
        WHERE a.tenant_id = $1
        ORDER BY a.start_time DESC
        LIMIT 50
        `,
        [tenantId]
      );

      return res.json({
        ok: true,
        appointments: rows,
      });
    } catch (error) {
      console.error("[GET /api/appointments] Error:", error);
      return res.status(500).json({
        ok: false,
        error: "INTERNAL_SERVER_ERROR",
      });
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
          updated_at
        `,
        [status, id, tenantId]
      );

      if (!rows[0]) {
        return res.status(404).json({
          ok: false,
          error: "APPOINTMENT_NOT_FOUND",
        });
      }

      const appt = rows[0];

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
