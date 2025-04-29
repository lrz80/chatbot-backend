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

    // Verifica que el tenant exista
    const tenantRes = await pool.query("SELECT * FROM tenants WHERE id = $1", [tenant_id]);
    const tenant = tenantRes.rows[0];
    if (!tenant) return res.status(404).json({ error: "Negocio no encontrado" });

    // 🧠 Importar OpenAI dinámicamente
    const { default: OpenAI } = await import("openai");
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "" });

    // 🔮 Generar prompt desde OpenAI
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

Información que el asistente debe conocer:
${informacion}

Redacta únicamente un texto claro y profesional (no JSON) que describa cómo debe comportarse el asistente. 
No incluyas ningún mensaje de bienvenida ni estructura técnica. 
Solo devuelve el texto plano que servirá como prompt de sistema.`,
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
