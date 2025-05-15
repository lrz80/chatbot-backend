// src/routes/auth/forgot-password.ts

import express from "express";
import pool from "../../lib/db";
import jwt from "jsonwebtoken";
import { sendPasswordResetEmail } from "../../lib/senders/email-smtp";

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || "recovery-secret";
const FRONTEND_URL = process.env.FRONTEND_URL || "https://www.aamy.ai";

router.post("/auth/forgot-password", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Correo requerido" });

  try {
    const userRes = await pool.query("SELECT id FROM users WHERE email = $1", [email]);
    if (userRes.rows.length === 0) {
      // No revelar si el email existe o no
      return res.status(200).json({ success: true });
    }

    const token = jwt.sign({ email }, JWT_SECRET, { expiresIn: "15m" });
    const link = `${FRONTEND_URL}/reset-password?token=${token}`;

    await sendPasswordResetEmail(email, link);

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("❌ Error en /auth/forgot-password:", err);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
});

export default router;
