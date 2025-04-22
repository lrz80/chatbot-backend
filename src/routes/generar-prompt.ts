import { Router, Request, Response } from "express";
import jwt, { JwtPayload } from "jsonwebtoken";
import pool from "../lib/db";
import OpenAI from "openai";

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || "secret-key";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

router.post("/", async (req: Request, res: Response) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: "Token requerido" });

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;
    const tenant_id = decoded.tenant_id;
    const { descripcion, informacion, idioma } = req.body;

    if (!descripcion || !informacion || !idioma) {
      return res.status(400).json({ error: "Faltan campos requeridos" });
    }

    // Verifica que el tenant exista
    const tenantRes = await pool.query("SELECT * FROM tenants WHERE id = $1", [tenant_id]);
    const tenant = tenantRes.rows[0];
    if (!tenant) return res.status(404).json({ error: "Negocio no encontrado" });

    // 🔮 Llamada a OpenAI para generar el prompt
    const completion = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        {
          role: "system",
          content: `Actúa como un generador de instrucciones para asistentes virtuales.`,
        },
        {
          role: "user",
          content: `Estoy creando un asistente virtual en ${idioma}. Su función principal es: ${descripcion}.
          
Aquí está la información clave del negocio que el asistente debe conocer:
${informacion}

Crea un prompt de sistema claro, en ${idioma}, que pueda usarse directamente para configurar al asistente.`,
        },
      ],
    });

    const prompt = completion.choices[0]?.message?.content || null;

    if (!prompt) {
      return res.status(500).json({ error: "No se pudo generar el prompt" });
    }

    res.status(200).json({ prompt });
  } catch (err) {
    console.error("❌ Error generando prompt:", err);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

export default router;
