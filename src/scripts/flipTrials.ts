// src/scripts/flipTrials.ts
import fetch from "node-fetch";

(async () => {
  try {
    console.log("🚀 Ejecutando script flipTrials...");
    const res = await fetch("https://api.aamy.ai/api/internal/cron/flip-trials", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-cron-secret": process.env.CRON_SECRET || "",
      },
    });

    if (!res.ok) {
      const text = await res.text();
      console.error("❌ Error HTTP:", res.status, text);
      process.exit(1);
    }

    const data = await res.json();
    console.log("✅ Resultado del cron flip-trials:", data);
  } catch (err) {
    console.error("💥 Error ejecutando flipTrials.ts:", err);
    process.exit(1);
  }
})();
