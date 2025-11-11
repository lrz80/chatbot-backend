import express, { Request, Response } from "express";
import pool from "../lib/db";
import { authenticateUser } from "../middleware/auth";

const router = express.Router();

// 🎁 Activar prueba gratis (solo si nunca la usó)
router.post("/claim-trial", authenticateUser, async (req: any, res: Response) => {
  try {
    const { tenant_id } = req.user;
    const TRIAL_DAYS = 14;

    const tenantRes = await pool.query(
      "SELECT trial_ever_claimed, membresia_activa FROM tenants WHERE id = $1",
      [tenant_id]
    );

    const tenant = tenantRes.rows[0];
    if (!tenant) return res.status(404).json({ error: "Tenant no encontrado" });

    if (tenant.trial_ever_claimed) {
      return res.status(409).json({ error: "La prueba gratis ya fue utilizada" });
    }

    // 🔹 Activar prueba gratis por 14 días
    await pool.query(
      `UPDATE tenants SET
        plan = 'trial',
        membresia_activa = true,
        membresia_vigencia = NOW() + INTERVAL '${TRIAL_DAYS} days',
        trial_ever_claimed = true,
        updated_at = NOW()
       WHERE id = $1`,
      [tenant_id]
    );

    return res.json({
      ok: true,
      message: `Prueba gratis activada por ${TRIAL_DAYS} días.`,
    });
  } catch (error) {
    console.error("❌ Error al activar prueba:", error);
    return res.status(500).json({ error: "Error al activar prueba" });
  }
});

export default router;
