import express from "express";
import pool from "../../lib/db";
import jwt from "jsonwebtoken";
import nodemailer from "nodemailer";

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || "recovery-secret";
const FRONTEND_URL = process.env.FRONTEND_URL || "https://www.aamy.ai";

const transporter = nodemailer.createTransport({
  service: "Gmail",
  auth: {
    user: process.env.EMAIL_FROM,
    pass: process.env.EMAIL_PASS,
  },
});

router.post("/auth/forgot-password", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Correo requerido" });

  try {
    const userRes = await pool.query("SELECT id FROM users WHERE email = $1", [email]);
    if (userRes.rows.length === 0) return res.status(200).json({ success: true }); // no revelar si existe o no

    const token = jwt.sign({ email }, JWT_SECRET, { expiresIn: "15m" });
    const link = `${FRONTEND_URL}/reset-password?token=${token}`;

    await transporter.sendMail({
      from: process.env.EMAIL_FROM,
      to: email,
      subject: "Recupera tu contraseña",
      html: `<p>Haz clic en el siguiente enlace para restablecer tu contraseña:</p><p><a href="${link}">${link}</a></p><p>Este enlace caduca en 15 minutos.</p>`
    });

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("❌ Error en /auth/forgot-password:", err);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
});

export default router;
