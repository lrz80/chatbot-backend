import express from "express";
import pool from "../../lib/db";
import nodemailer from "nodemailer";

const router = express.Router();

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_FROM,
    pass: process.env.EMAIL_PASS,
  },
});

router.post("/auth/resend-code", async (req, res) => {
  const { email } = req.body;

  if (!email) return res.status(400).json({ error: "Correo requerido" });

  try {
    const userRes = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
    const user = userRes.rows[0];

    if (!user) return res.status(404).json({ error: "Usuario no encontrado" });
    if (user.verificado) return res.status(400).json({ error: "La cuenta ya está verificada" });

    const newCode = Math.floor(100000 + Math.random() * 900000).toString();

    await pool.query(
      "UPDATE users SET codigo_verificacion = $1 WHERE email = $2",
      [newCode, email]
    );

    await transporter.sendMail({
      from: process.env.EMAIL_FROM,
      to: email,
      subject: "Nuevo código de verificación",
      text: `Tu nuevo código de verificación es: ${newCode}`,
    });

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("❌ Error en /auth/resend-code:", err);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
});

export default router;
