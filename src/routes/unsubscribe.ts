// 📁 src/routes/unsubscribe.ts
import express from "express";
import pool from "../lib/db";

const router = express.Router();

router.get("/unsubscribe", async (req, res) => {
  const { email, tenant } = req.query;

  if (!email || !tenant) {
    return res.status(400).send("Faltan parámetros obligatorios.");
  }

  try {
    const result = await pool.query(
      `INSERT INTO unsubscribed_emails (tenant_id, email, fecha) 
       VALUES ($1, $2, NOW()) 
       ON CONFLICT (tenant_id, email) DO NOTHING`,
      [tenant, email]
    );

    res.send(`
      <html>
        <head>
          <title>Suscripción cancelada</title>
        </head>
        <body style="font-family:Arial,sans-serif; text-align:center; padding:40px;">
          <h2>🛑 Has cancelado tu suscripción</h2>
          <p>Ya no recibirás más correos de este remitente.</p>
        </body>
      </html>
    `);
  } catch (err) {
    console.error("❌ Error al cancelar suscripción:", err);
    res.status(500).send("Error al cancelar suscripción.");
  }
});

export default router;
