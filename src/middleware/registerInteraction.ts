// 📁 chatbot-backend/middleware/registerInteraction.ts

import pool from "../lib/db";

export async function registerInteraction(uid: string, canal: string = "whatsapp") {
  try {
    await pool.query(
      "INSERT INTO interactions (uid, canal) VALUES ($1, $2)",
      [uid, canal]
    );
  } catch (error) {
    console.error("❌ Error registrando interacción:", error);
  }
}
