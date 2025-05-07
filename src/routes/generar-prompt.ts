// src/routes/generar-prompt.ts

import { Router, Request, Response } from "express";
import jwt, { JwtPayload } from "jsonwebtoken";
import pool from "../lib/db";

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || "secret-key";

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

    const tenantRes = await pool.query("SELECT * FROM tenants WHERE id = $1", [tenant_id]);
    const tenant = tenantRes.rows[0];
    if (!tenant) return res.status(404).json({ error: "Negocio no encontrado" });

    const { default: OpenAI } = await import("openai");
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "" });

    const completion = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        {
          role: "system",
          content: `Eres un generador experto de instrucciones para asistentes virtuales.`,
        },
        {
          role: "user",
          content: `Estoy creando un asistente en ${idioma}. Su nombre es Amy y nunca debe decir que no se llama Amy. Amy debe hablar como si fuera parte del equipo del negocio "${tenant.name}". Nunca debe responder en nombre de otro asistente o empresa.

Estas son sus funciones:
${descripcion}

Esta es la información clave que debe conocer:
${informacion}

Redacta un único texto en lenguaje natural que incluya sus funciones ${descripcion} y la informacion clave del negocio ${informacion} y que describa cómo debe comportarse este asistente. No incluyas ningún mensaje de bienvenida, ni JSON, ni listas técnicas. Solo devuelve un texto plano profesional que servirá como prompt del sistema.`,
        },
      ],
    });

    const prompt = completion.choices[0]?.message?.content?.trim();
    if (!prompt) return res.status(500).json({ error: "No se pudo generar el prompt" });

    res.status(200).json({ prompt });
  } catch (err) {
    console.error("❌ Error generando prompt:", err);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

export default router;
