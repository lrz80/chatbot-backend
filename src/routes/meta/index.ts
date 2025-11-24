// src/routes/meta/index.ts
import { Router, Request, Response } from "express";
import pool from "../../lib/db";

import whatsappOnboard from "./whatsapp-onboard-start";
import whatsappCallback from "./whatsapp-callback";
import whatsappRedirect from "./whatsapp-redirect";

const router = Router();

// Ruta que inicia el flujo OAuth "simple" para conectar WhatsApp
router.use("/whatsapp-onboard", whatsappOnboard);

// Ruta que recibe el callback de Meta después del signup
router.use("/whatsapp/callback", whatsappCallback);

// Ruta opcional que usa tu front al regresar desde Meta
router.use("/whatsapp-redirect", whatsappRedirect);

/**
 * GET /api/meta/whatsapp/accounts
 *
 * Devuelve los números de WhatsApp conectados para el tenant autenticado.
 * El frontend lo usa para mostrar "Ver números disponibles".
 */
router.get("/whatsapp/accounts", async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const tenantId = user?.tenant_id as string | undefined;

    if (!tenantId) {
      return res
        .status(401)
        .json({ error: "No autenticado: falta tenant_id en el token." });
    }

    const { rows } = await pool.query(
      `SELECT
         whatsapp_business_id,
         whatsapp_phone_number_id,
         whatsapp_phone_number,
         name
       FROM tenants
       WHERE id = $1
       LIMIT 1`,
      [tenantId]
    );

    const row = rows[0];
    if (!row) {
      return res.status(404).json({ error: "Tenant no encontrado." });
    }

    const phoneNumbers: Array<{
      waba_id: string | null;
      phone_number_id: string | null;
      display_phone_number: string | null;
      verified_name: string | null;
    }> = [];

    if (row.whatsapp_phone_number_id && row.whatsapp_phone_number) {
      phoneNumbers.push({
        waba_id: row.whatsapp_business_id ?? null,
        phone_number_id: row.whatsapp_phone_number_id ?? null,
        display_phone_number: row.whatsapp_phone_number ?? null,
        verified_name: row.name ?? null,
      });
    }

    // Exponemos tanto "phoneNumbers" como "accounts" por compatibilidad
    return res.json({
      phoneNumbers,
      accounts: phoneNumbers,
    });
  } catch (err) {
    console.error("[WA ACCOUNTS] Error listando números:", err);
    return res
      .status(500)
      .json({ error: "Error listando cuentas de WhatsApp." });
  }
});

export default router;
