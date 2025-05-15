// 📁 src/routes/verify.ts

import { Router, Request, Response } from "express";
import jwt, { JwtPayload } from "jsonwebtoken";
import pool from "../lib/db";
import { sendWelcomeEmail } from "../lib/senders/email-smtp";

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || "secret-key";

router.post("/", async (req: Request, res: Response) => {
  const token = req.cookies?.token;
  const { codigo } = req.body;

  if (!token) return res.status(401).json({ error: "Token requerido" });
  if (!codigo) return res.status(400).json({ error: "Código requerido" });

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;
    const uid = decoded.uid;

    const userRes = await pool.query("SELECT * FROM users WHERE uid = $1", [uid]);
    const user = userRes.rows[0];
    if (!user) return res.status(404).json({ error: "Usuario no encontrado" });

    if (user.codigo_verificacion !== codigo) {
      return res.status(401).json({ error: "Código incorrecto" });
    }

    await pool.query(
      "UPDATE users SET verificado = true, codigo_verificacion = NULL WHERE uid = $1",
      [uid]
    );

    // ✅ Notificar por email que su cuenta fue verificada correctamente
    const mensaje = `
      Tu correo ha sido verificado exitosamente ✅. Ya puedes acceder a todas las funciones de la plataforma.
    `;
    await sendWelcomeEmail(user.email);

    return res.status(200).json({ message: "Correo verificado exitosamente ✅" });
  } catch (err) {
    console.error("❌ Error al verificar código:", err);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
});

export default router;
