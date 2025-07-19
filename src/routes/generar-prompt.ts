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

    if (!tenant.membresia_activa) {
      return res.status(403).json({ error: "Membresía inactiva. Actívala para generar prompts." });
    }

    const { default: OpenAI } = await import("openai");
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "" });

    const nombreNegocio = tenant.name || "nuestro negocio";
    const funciones = descripcion.replace(/\\n/g, '\n').replace(/\r/g, '').trim();
    const info = informacion.replace(/\\n/g, '\n').replace(/\r/g, '').trim();

    console.log("📤 Enviando a OpenAI:");
    console.log("Funciones:", funciones);
    console.log("Información:", info);

    const completion = await openai.chat.completions.create({
      model: "gpt-4",
      temperature: 0.4,
      messages: [
        {
          role: "system",
          content: `Eres un generador experto de instrucciones para asistentes.`,
        },
        {
          role: "user",
          content: `Estoy creando un asistente en ${idioma}. Su nombre es Amy y nunca debe decir que no se llama Amy. Amy debe hablar como si fuera parte del equipo del negocio "${nombreNegocio}". Nunca debe responder en nombre de otro asistente o empresa.

Estas son sus funciones:
${funciones}

Esta es la información clave que debe conocer:
${info}

🔒 IMPORTANTE: El asistente solo debe responder con la información que se le ha proporcionado. Si la pregunta del cliente no se encuentra en esta información, debe decir educadamente: "Lo siento, no tengo esa información disponible en este momento".

Redacta un único texto en lenguaje natural que combine toda la información y describa cómo debe comportarse este asistente. Es importante que incluyas explícitamente todos los detalles, precios, nombres de planes, enlaces o beneficios tal como fueron proporcionados, sin resumir ni agrupar por categorías. No incluyas mensaje de bienvenida, JSON, ni listas técnicas. Solo devuelve un texto plano profesional que servirá como prompt del sistema.`,

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
