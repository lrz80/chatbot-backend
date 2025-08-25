// src/routes/contactos/index.ts
import express from "express";
import multer from "multer";
import pool from "../../lib/db";
import { authenticateUser } from "../../middleware/auth";

const router = express.Router();

/**
 * Storage en memoria (evita IO en disco y simplifica).
 * Si prefieres en disco, puedes volver a diskStorage sin tocar la lógica de cupo.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

// ----------------- Helpers de capacidad dinámica -----------------
async function getCapacidadContactos(tenantId: string) {
  // Usados reales (almacenados)
  const { rows: r1 } = await pool.query(
    "SELECT COUNT(*)::int AS total FROM contactos WHERE tenant_id = $1",
    [tenantId]
  );
  const total = r1[0]?.total ?? 0;

  // Extras vigentes: válidos hasta la MISMA hora/minuto/segundo de la compra
  const { rows: r2 } = await pool.query(
    `
    SELECT COALESCE(SUM(cantidad),0)::int AS extra_vigente
    FROM creditos_comprados
    WHERE tenant_id = $1
      AND canal = 'contactos'
      AND NOW() <= fecha_vencimiento
    `,
    [tenantId]
  );
  const extraVigente = r2[0]?.extra_vigente ?? 0;

  const limite = 500 + extraVigente;
  const restante = Math.max(limite - total, 0);
  return { total, limite, restante };
}

// Utilidad para leer columnas flexibles
function pick(headers: string[], cols: string[], keys: string[]) {
  for (const k of keys) {
    const idx = headers.indexOf(k);
    if (idx >= 0) return (cols[idx] ?? "").replace(/"/g, "").trim();
  }
  return "";
}

/** ==== NUEVO: helpers para detectar columna de segmento y mapear valores ==== */
// Orden de búsqueda de columna de segmento (multi-tenant, tolerante)
const SEGMENT_COLUMN_CANDIDATES = ["segmento", "segment", "lead status", "status", "tipo"];

function pickSegmentColumn(headers: string[]) {
  // headers vienen ya en minúsculas
  for (const c of SEGMENT_COLUMN_CANDIDATES) {
    const i = headers.indexOf(c);
    if (i >= 0) return i;
  }
  return -1; // no hay columna reconocible
}

function mapToSegment(raw: string) {
  const s = (raw || "").trim().toLowerCase();
  const map: Record<string, "cliente" | "leads" | "otros"> = {
    // leads
    "lead": "leads",
    "leads": "leads",
    "prospect": "leads",
    "prospecto": "leads",
    "potential": "leads",
    "mql": "leads",
    "sql": "leads",
    // cliente
    "cliente": "cliente",
    "client": "cliente",
    "customer": "cliente",
    "member": "cliente",
    "miembro": "cliente",
    "activo": "cliente",
    // otros
    "otro": "otros",
    "otros": "otros",
    "other": "otros",
    "none": "otros",
    "na": "otros",
    "n/a": "otros",
    "desconocido": "otros",
    // vacío → cliente
    "": "cliente",
  };
  // Si ya viene exactamente uno de los 3, respétalo; si no, mapea o cae en 'cliente'
  if (s === "cliente" || s === "leads" || s === "otros") return s as any;
  return map[s] ?? "cliente";
}

const PHONE_RE = /^\+?\d{10,15}$/;

// 📥 Subir archivo CSV de contactos (con cupo dinámico)
router.post("/", authenticateUser, upload.single("file"), async (req, res) => {
  const { tenant_id } = req.user as { tenant_id: string };
  if (!req.file) return res.status(400).json({ error: "Archivo no proporcionado." });

  try {
    // Lee CSV desde memoria
    const content = req.file.buffer.toString("utf8");

    const lines = content
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));

    if (lines.length < 2) {
      return res.status(400).json({ error: "El archivo está vacío o mal formado." });
    }

    const rawHeaders = lines[0]
      .split(",")
      .map((h) => h.replace(/"/g, "").trim().toLowerCase());
    const dataLines = lines.slice(1);

    // 🔐 Capacidad dinámica
    const { total, limite, restante } = await getCapacidadContactos(tenant_id);
    if (restante <= 0) {
      return res.status(403).json({
        error: `Ya has alcanzado tu límite de contactos (${limite}).`,
      });
    }

    // NUEVO: detectar columna de segmento y leer 'segmento_default' opcional del request
    const idxSegmento = pickSegmentColumn(rawHeaders);
    const reqDefault = ((req.body as any)?.segmento_default || "").toString().toLowerCase();
    const segmentoDefault =
      reqDefault === "cliente" || reqDefault === "leads" || reqDefault === "otros"
        ? (reqDefault as "cliente" | "leads" | "otros")
        : ("cliente" as const);

    let nuevos = 0;

    // Procesa sólo hasta el cupo disponible
    const porProcesar = dataLines.slice(0, restante);

    for (const line of porProcesar) {
      const cols = line.split(",").map((c) => c.trim());

      const firstName = pick(rawHeaders, cols, ["nombre", "first name", "firstname", "name"]);
      const lastName = pick(rawHeaders, cols, ["last name", "lastname", "apellido"]);
      const nombre = `${firstName} ${lastName}`.trim() || "Sin nombre";

      const telefono = pick(rawHeaders, cols, ["telefono", "phone", "tel"]);
      const email = pick(rawHeaders, cols, ["email", "correo"]);

      // NUEVO: lee valor crudo de la columna detectada y mapea; si no hay, usa segmento_default
      const rawSeg = idxSegmento >= 0 ? (cols[idxSegmento] ?? "") : "";
      const segmento = rawSeg ? mapToSegment(rawSeg) : segmentoDefault;

      // Reglas mínimas: al menos 1 identificador y teléfono válido si viene
      if (!telefono && !email) continue;
      if (telefono && !PHONE_RE.test(telefono)) continue;

      // Evitar duplicados por (telefono) o (email)
      const existe = await pool.query(
        `SELECT id FROM contactos
         WHERE tenant_id = $1
           AND ( ($2 <> '' AND telefono = $2) OR ($3 <> '' AND email = $3) )`,
        [tenant_id, telefono, email]
      );

      if ((existe.rows?.length ?? 0) > 0) {
        const id = existe.rows[0].id;
        await pool.query(
          "UPDATE contactos SET nombre = $1, segmento = $2 WHERE id = $3",
          [nombre, segmento, id]
        );
      } else {
        await pool.query(
          `INSERT INTO contactos (tenant_id, nombre, telefono, email, segmento, fecha_creacion)
           VALUES ($1, $2, $3, $4, $5, NOW())`,
          [tenant_id, nombre, telefono, email, segmento]
        );
        nuevos++;
      }
    }

    // (Opcional) Mantener un registro en uso_mensual (informativo)
    // ⚠️ Importante: usar el límite REAL del mes, no hardcode 500
    await pool.query(
      `
      INSERT INTO uso_mensual (tenant_id, canal, mes, usados, limite)
      VALUES ($1, 'contactos', date_trunc('month', CURRENT_DATE), $2, $3)
      ON CONFLICT (tenant_id, canal, mes)
      DO UPDATE SET usados = uso_mensual.usados + EXCLUDED.usados,
                    limite = EXCLUDED.limite
      `,
      [tenant_id, nuevos, limite]
    );

    // Recalcular para responder valores frescos
    const post = await getCapacidadContactos(tenant_id);

    res.json({
      ok: true,
      nuevos,
      total_ahora: post.total,
      limite: post.limite,
      restante: post.restante,
      mensaje: `Se procesaron ${nuevos} contactos nuevos.`,
    });
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

export default router;
