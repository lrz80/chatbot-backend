// src/routes/sendgrid/templates.ts

import express from "express";
import sgClient from "@sendgrid/client";
import { authenticateUser } from "../../middleware/auth";

const router = express.Router();
sgClient.setApiKey(process.env.SENDGRID_API_KEY!);

router.get("/", authenticateUser, async (req, res) => {
  try {
    const [response, body] = await sgClient.request({
      method: "GET",
      url: "/v3/templates",
    });

    const templates = (body?.templates || []).map((t: any) => ({
      id: t.id,
      name: t.name,
      updated_at: t.updated_at,
    }));

    return res.json(templates);
  } catch (error) {
    console.error("❌ Error al obtener plantillas de SendGrid:", error);
    return res.status(500).json({ error: "No se pudieron cargar las plantillas." });
  }
});

export default router;
