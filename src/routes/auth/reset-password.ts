// src/routes/auth/reset-password.ts

import express from "express";
import pool from "../../lib/db";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { sendPasswordResetEmail } from "@/lib/senders/email-smtp";

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || "recovery-secret";

router.post("/auth/reset-password", async (req, res) => {
  const { token, newPassword } = req.body;

  if (!token || !newPassword) {
    return res.status(400).json({ error: "Token y nueva contraseña requeridos" });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const { email } = decoded as { email: string };

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await pool.query("UPDATE users SET password = $1 WHERE email = $2", [hashedPassword, email]);

    // ✅ Envía confirmación de cambio de contraseña
    const resetConfirmation = `
      Tu contraseña ha sido cambiada exitosamente. Si no hiciste esta acción,
      por favor contáctanos de inmediato o intenta restablecerla nuevamente.
    `;
    await sendPasswordResetEmail(email, "#"); // Enlace opcional: "#" ya que es solo confirmación

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("❌ Error en /auth/reset-password:", err);
    return res.status(401).json({ error: "Token inválido o expirado" });
  }
});

export default router;
