// src/routes/preview-email.ts
import express from "express";
import { generarHTMLCorreo } from "../utils/email-html";

const router = express.Router();

router.post("/", (req, res) => {
  const {
    contenido,
    nombreNegocio,
    imagenUrl,
    linkUrl,
    logoUrl,
    email,
    tenantId,
    nombreContacto,
    asunto,
    tituloVisual,
  } = req.body;

  try {
    const html = generarHTMLCorreo(
      contenido,
      nombreNegocio,
      imagenUrl,
      linkUrl,
      logoUrl,
      email,
      tenantId,
      nombreContacto,
      asunto,
      tituloVisual
    );
    return res.send(html);
  } catch (err) {
    console.error("❌ Error generando preview:", err);
    return res.status(500).send("Error generando preview.");
  }
});

export default router;
