import express from "express";
import { authenticateUser } from "../../middleware/auth";
import { PromptTemplate } from "../../utils/voicePromptTemplate"; // Asegúrate de crear este archivo

const router = express.Router();

router.post("/", authenticateUser, async (req, res) => {
  const { idioma, categoria } = req.body;

  if (!idioma || !categoria) {
    return res.status(400).json({ error: "Faltan idioma o categoría." });
  }

  try {
    // Lógica para generar el prompt
    const { prompt, bienvenida } = PromptTemplate({ idioma, categoria });
    res.json({ prompt, bienvenida });
  } catch (err) {
    console.error("❌ Error generando prompt de voz:", err);
    res.status(500).json({ error: "Error generando prompt." });
  }
});

export default router;
