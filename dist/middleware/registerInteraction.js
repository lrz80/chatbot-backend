"use strict";
// 📁 chatbot-backend/middleware/registerInteraction.ts
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerInteraction = registerInteraction;
const db_1 = __importDefault(require("../lib/db"));
async function registerInteraction(uid, canal = "whatsapp") {
    try {
        await db_1.default.query("INSERT INTO interactions (uid, canal) VALUES ($1, $2)", [uid, canal]);
    }
    catch (error) {
        console.error("❌ Error registrando interacción:", error);
    }
}
