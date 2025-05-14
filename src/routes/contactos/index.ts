// src/routes/contactos/index.ts

import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import pool from "../../lib/db";
import { authenticateUser } from "../../middleware/auth";

const router = express.Router();

// ✅ Configuración de subida de archivos CSV
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, "../../../uploads");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const uniqueName = Date.now() + "-" + file.originalname;
    cb(null, uniqueName);
  },
});

const upload = multer({ storage });

// 📥 Subir archivo CSV de contactos
router.post("/", authenticateUser, upload.single("file"), async (req, res) => {
  const { tenant_id } = req.user as { tenant_id: string };
  if (!req.file) return res.status(400).json({ error: "Archivo no proporcionado." });

  try {
    const content = fs.readFileSync(req.file.path, "utf8");

    const lines = content
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));

    if (lines.length < 2) return res.status(400).json({ error: "El archivo está vacío o mal formado." });

    const headers = lines[0].toLowerCase().split(",").map((h) => h.trim());
    const dataLines = lines.slice(1);

    let nuevos = 0;

    for (const line of dataLines) {
      const cols = line.split(",").map((c) => c.trim());

      const nombre =
        cols[headers.indexOf("nombre")] ||
        cols[headers.indexOf("first name")] ||
        "Sin nombre";

      const telefono =
        cols[headers.indexOf("telefono")] ||
        cols[headers.indexOf("phone")] ||
        "";

      const email =
        cols[headers.indexOf("email")] || "";

      const segmento =
        cols[headers.indexOf("segmento")]?.toLowerCase() || "cliente";

      if (!telefono && !email) continue;

      const existe = await pool.query(
        "SELECT 1 FROM contactos WHERE tenant_id = $1 AND (telefono = $2 OR email = $3)",
        [tenant_id, telefono, email]
      );

      if (existe.rowCount === 0) {
        await pool.query(
          `INSERT INTO contactos (tenant_id, nombre, telefono, email, segmento, fecha_creacion)
           VALUES ($1, $2, $3, $4, $5, NOW())`,
          [tenant_id, nombre, telefono, email, segmento]
        );
        nuevos++;
      }
    }

    res.json({ ok: true, nuevos });
  } catch (err) {
    console.error("❌ Error al subir contactos:", err);
    res.status(500).json({ error: "Error al procesar archivo." });
  }
});

// 🧼 Eliminar todos los contactos del tenant
router.delete("/", authenticateUser, async (req, res) => {
  const { tenant_id } = req.user as { tenant_id: string };

  try {
    await pool.query("DELETE FROM contactos WHERE tenant_id = $1", [tenant_id]);
    res.json({ ok: true, message: "Contactos eliminados correctamente." });
  } catch (err) {
    console.error("❌ Error al eliminar contactos:", err);
    res.status(500).json({ error: "Error al eliminar contactos." });
  }
});

// 📦 Obtener todos los contactos del tenant
router.get("/", authenticateUser, async (req, res) => {
  const { tenant_id } = req.user as { tenant_id: string };

  try {
    const result = await pool.query(
      "SELECT nombre, telefono, email, segmento FROM contactos WHERE tenant_id = $1",
      [tenant_id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("❌ Error al obtener contactos:", err);
    res.status(500).json({ error: "Error al obtener contactos" });
  }
});

// 🔢 Contar contactos
router.get("/count", authenticateUser, async (req, res) => {
  const { tenant_id } = req.user as { tenant_id: string };

  try {
    const result = await pool.query(
      "SELECT COUNT(*)::int AS total FROM contactos WHERE tenant_id = $1",
      [tenant_id]
    );
    res.json({ total: result.rows[0].total });
  } catch (err) {
    console.error("❌ Error al contar contactos:", err);
    res.status(500).json({ error: "Error al contar contactos." });
  }
});

// ➕ Crear contacto manual
router.post("/manual", authenticateUser, async (req, res) => {
  const { tenant_id } = req.user as { tenant_id: string };
  const { nombre, telefono, email, segmento } = req.body;

  if (!telefono && !email) {
    return res.status(400).json({ error: "Debe proporcionar teléfono o email." });
  }

  try {
    const existe = await pool.query(
      "SELECT 1 FROM contactos WHERE tenant_id = $1 AND (telefono = $2 OR email = $3)",
      [tenant_id, telefono, email]
    );

    if ((existe?.rowCount ?? 0) > 0) {
      return res.status(400).json({ error: "Ya existe un contacto con este teléfono o email." });
    }

    const limiteRes = await pool.query(
      "SELECT limite_contactos FROM tenants WHERE id = $1",
      [tenant_id]
    );
    const limite = limiteRes.rows[0]?.limite_contactos ?? 500;

    const totalRes = await pool.query(
      "SELECT COUNT(*)::int AS total FROM contactos WHERE tenant_id = $1",
      [tenant_id]
    );
    const total = totalRes.rows[0].total;

    if (total >= limite) {
      return res.status(403).json({ error: "Límite de contactos alcanzado." });
    }

    const insert = await pool.query(
      `INSERT INTO contactos (tenant_id, nombre, telefono, email, segmento, fecha_creacion)
       VALUES ($1, $2, $3, $4, $5, NOW())
       RETURNING nombre, telefono, email, segmento`,
      [tenant_id, nombre || "Sin nombre", telefono, email, segmento || "cliente"]
    );

    res.status(201).json(insert.rows[0]);
  } catch (err) {
    console.error("❌ Error al crear contacto manual:", err);
    res.status(500).json({ error: "Error interno al guardar contacto." });
  }
});

export default router;
