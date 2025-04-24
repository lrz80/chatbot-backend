// src/routes/prompt-generator/voice.ts

import express from "express";
import { authenticateUser } from "../../middleware/auth";
import { PromptTemplate } from "../../utils/voicePromptTemplate";

const router = express.Router();

router.post("/", authenticateUser, async (req, res) => {
  const { idioma, categoria } = req.body;
  const tenant_id = req.user?.tenant_id;

  if (!idioma || !categoria) {
    return res.status(400).json({ error: "Faltan idioma o categoría." });
  }

  if (!tenant_id) {
    return res.status(401).json({ error: "Tenant no autenticado." });
  }

  try {
    const { prompt, bienvenida } = await PromptTemplate({ idioma, categoria, tenant_id });
    res.json({ prompt, bienvenida });
  } catch (err) {
    console.error("❌ Error generando prompt de voz:", err);
    res.status(500).json({ error: "Error generando prompt." });
  }
});

export default router;
