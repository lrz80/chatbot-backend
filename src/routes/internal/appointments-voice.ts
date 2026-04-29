//src/routes/internal/appointments-voice.ts
import { Router, Request, Response } from "express";
import pool from "../../lib/db";

const router = Router();

router.post("/book-from-voice", async (req: Request, res: Response) => {
  try {
    const {
      tenant_id,
      service_name,
      customer_phone,
      datetime,
    } = req.body;

    if (!tenant_id || !customer_phone || !datetime) {
      return res.status(400).json({
        ok: false,
        error: "MISSING_FIELDS",
      });
    }

    const start = new Date(datetime);
    const end = new Date(start.getTime() + 30 * 60000); // 30 min default

    const { rows } = await pool.query(
      `
      INSERT INTO appointments (
        tenant_id,
        service_id,
        channel,
        customer_name,
        customer_phone,
        start_time,
        end_time,
        status
      )
      VALUES ($1, NULL, 'voice', 'Cliente Voz', $2, $3, $4, 'pending')
      RETURNING *
      `,
      [
        tenant_id,
        customer_phone,
        start.toISOString(),
        end.toISOString(),
      ]
    );

    return res.json({
      ok: true,
      appointment: rows[0],
    });

  } catch (err) {
    console.error("❌ [VOICE BOOKING]", err);
    return res.status(500).json({
      ok: false,
      error: "SERVER_ERROR",
    });
  }
});

export default router;