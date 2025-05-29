"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const axios_1 = __importDefault(require("axios"));
const router = express_1.default.Router();
router.get("/", async (req, res) => {
    try {
        const response = await axios_1.default.get("https://api.elevenlabs.io/v1/voices", {
            headers: {
                "xi-api-key": process.env.ELEVENLABS_API_KEY || "",
            },
        });
        const voices = response.data?.voices || [];
        // Mapear y ordenar alfabéticamente
        const formatted = voices
            .map((v) => ({
            label: v.name,
            value: v.voice_id,
        }))
            .sort((a, b) => a.label.localeCompare(b.label));
        res.json(formatted);
    }
    catch (err) {
        console.error("❌ Error al obtener voces de ElevenLabs:", err);
        res.status(500).json({ error: "No se pudieron obtener las voces." });
    }
});
exports.default = router;
