import express, { Request, Response } from "express";
import jwt from "jsonwebtoken";

import pool from "../../lib/db";
import { sendPasswordResetEmail } from "../../lib/senders/email-smtp";

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  throw new Error("JWT_SECRET no está configurado");
}

const FRONTEND_URL =
  process.env.FRONTEND_URL?.replace(/\/+$/, "") ||
  "https://www.aamy.ai";

function normalizeEmail(value: unknown): string {
  return typeof value === "string"
    ? value.trim().toLowerCase()
    : "";
}

router.post(
  "/auth/forgot-password",
  async (req: Request, res: Response) => {
    const email = normalizeEmail(req.body?.email);

    if (!email) {
      return res.status(400).json({
        error: "Correo requerido",
      });
    }

    try {
      const userRes = await pool.query(
        `
          SELECT uid, email
          FROM users
          WHERE LOWER(email) = $1
          LIMIT 1
        `,
        [email]
      );

      const user = userRes.rows[0];

      /*
       * No revelar si el correo existe.
       */
      if (!user) {
        return res.status(200).json({
          success: true,
        });
      }

      const token = jwt.sign(
        {
          purpose: "password_reset",
          uid: user.uid,
          email: user.email,
        },
        JWT_SECRET,
        {
          expiresIn: "15m",
        }
      );

      const link =
        `${FRONTEND_URL}/reset-password` +
        `?token=${encodeURIComponent(token)}`;

      await sendPasswordResetEmail(user.email, link);

      return res.status(200).json({
        success: true,
      });
    } catch (error) {
      console.error("❌ Error en /auth/forgot-password:", error);

      return res.status(500).json({
        error: "Error interno del servidor",
      });
    }
  }
);

export default router;