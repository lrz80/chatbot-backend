// src/routes/email-status/index.ts

import { Router } from "express";
import pool from "../../lib/db";
import { authenticateUser } from "../../middleware/auth";

const router = Router();

router.get("/", authenticateUser, async (req, res) => {
  const { tenant_id } = req.user!;
  const { campaign_id } = req.query;

  try {
    let query = `
  SELECT email, status, error_message, timestamp
  FROM email_status_logs
  WHERE tenant_id = $1
`;
const params: any[] = [tenant_id];

if (campaign_id) {
  query += " AND campaign_id = $2";
  params.push(Number(campaign_id));
}

query += " ORDER BY timestamp DESC LIMIT 100";

    const result = await pool.query(query, params);

    res.json(result.rows);
  } catch (err) {
    console.error("❌ Error obteniendo logs de email:", err);
    res.status(500).json({ error: "Error obteniendo logs" });
  }
});

export default router;
