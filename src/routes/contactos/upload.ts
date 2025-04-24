import express from "express";
import multer from "multer";
import csvParser from "csv-parser";
import pool from "../../lib/db";
import { authenticateUser } from "../../middleware/auth";
import { Readable } from "stream";

const router = express.Router();
const upload = multer();

router.post("/upload", authenticateUser, upload.single("file"), async (req, res) => {
  const { tenant_id } = req.user as { tenant_id: string };

  if (!req.file) {
    return res.status(400).json({ error: "Archivo no proporcionado." });
  }

  const contactos: { nombre?: string; email?: string; telefono?: string; segmento?: string }[] = [];

  try {
    // Obtener cuántos contactos tiene el tenant actualmente
    const existing = await pool.query("SELECT COUNT(*) FROM contactos WHERE tenant_id = $1", [tenant_id]);
    const existentes = parseInt(existing.rows[0].count || "0", 10);

    const stream = Readable.from(req.file.buffer);
    await new Promise((resolve, reject) => {
      stream
        .pipe(csvParser())
        .on("data", (row) => {
          const { nombre, email, telefono, segmento } = row;
          if (email || telefono) {
            contactos.push({ nombre, email, telefono, segmento });
          }
        })
        .on("end", resolve)
        .on("error", reject);
    });

    if (contactos.length + existentes > 300) {
      return res.status(400).json({ error: "Máximo 300 contactos permitidos por tenant." });
    }

    // Eliminar duplicados (teléfono o email ya existente)
    const existentesQuery = await pool.query(
      "SELECT telefono, email FROM contactos WHERE tenant_id = $1",
      [tenant_id]
    );
    const existentesMap = new Set(
      existentesQuery.rows.map((r) => r.telefono + "|" + r.email)
    );

    const nuevosUnicos = contactos.filter((c) => {
      const clave = (c.telefono || "") + "|" + (c.email || "");
      if (existentesMap.has(clave)) return false;
      existentesMap.add(clave);
      return true;
    });

    for (const contacto of nuevosUnicos) {
      await pool.query(
        `INSERT INTO contactos (tenant_id, nombre, email, telefono, segmento)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          tenant_id,
          contacto.nombre || null,
          contacto.email || null,
          contacto.telefono || null,
          contacto.segmento || null,
        ]
      );
    }

    res.status(200).json({ ok: true, nuevos: nuevosUnicos.length });
  } catch (err) {
    console.error("❌ Error al subir contactos:", err);
    res.status(500).json({ error: "Error al procesar archivo CSV." });
  }
});

export default router;
