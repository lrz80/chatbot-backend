// src/routes/elevenlabs/voices.ts
import express from "express";
import axios from "axios";

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const response = await axios.get("https://api.elevenlabs.io/v1/voices", {
      headers: {
        "xi-api-key": process.env.ELEVENLABS_API_KEY || "",
      },
    });

    const voices = response.data?.voices || [];
    res.json(voices.map((v: any) => ({
      label: v.name,
      value: v.voice_id
    })));
  } catch (err) {
    console.error("❌ Error al obtener voces de ElevenLabs:", err);
    res.status(500).json({ error: "No se pudieron obtener las voces." });
  }
});

export default router;
