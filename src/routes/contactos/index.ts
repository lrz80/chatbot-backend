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

type Segmento = "cliente" | "leads" | "otros";

function normVal(v: any) {
  return String(v ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function isTruthy(v: any) {
  const s = normVal(v);
  return ["true", "yes", "y", "si", "sí", "1", "ok"].includes(s);
}

function parseNumberLoose(v: any): number | null {
  const s = String(v ?? "").replace(/,/g, "").trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function parseDateLoose(v: any): number | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const d = new Date(s);
  const t = d.getTime();
  return Number.isFinite(t) ? t : null;
}

// ✅ Inferir segmento sin depender de columnas (usa TODOS los valores de la fila)
function inferSegmentFromRow(rawLine: string, headers: string[], cols: string[]): Segmento {
  // 1) Señales fuertes por texto (en cualquier columna)
  const joined = cols.map(normVal).join(" | ");

  const strongOtros = ["cancel", "expired", "inactive", "blocked", "opt out", "unsub", "do not contact", "dnc"];
  const strongCliente = ["active", "member", "subscribed", "paid", "vip", "premium", "gold", "platinum", "pro"];
  const strongLeads = ["lead", "prospect", "trial", "new", "interested", "inquiry"];

  if (strongOtros.some(w => joined.includes(w))) return "otros";
  if (strongCliente.some(w => joined.includes(w))) return "cliente";
  if (strongLeads.some(w => joined.includes(w))) return "leads";

  // 2) Señales numéricas: si hay algún contador > 0 -> cliente
  for (const c of cols) {
    const n = parseNumberLoose(c);
    if (n !== null && n > 0) return "cliente";
  }

  // 3) Señales de fechas: si hay una fecha FUTURA en la fila, normalmente indica vigencia/expiración/plan -> cliente
  const now = Date.now();
  for (const c of cols) {
    const t = parseDateLoose(c);
    if (t !== null && t > now + 24 * 60 * 60 * 1000) return "cliente";
  }

  // 4) Default conservador
  return "leads";
}

// (Opcional) detectar si hay consentimiento SMS en cualquier parte (sin depender de header)
// Si NO existe la señal, no bloquea (devuelve true).
function inferSmsConsent(headers: string[], cols: string[]): boolean {
  // intentamos detectar campos que mencionen sms/text + consent/opt/permission
  const h = headers.map(h => h.toLowerCase());
  const idxCandidates: number[] = [];
  for (let i = 0; i < h.length; i++) {
    const hk = h[i];
    const hasSms = hk.includes("sms") || hk.includes("text");
    const hasConsent = hk.includes("consent") || hk.includes("opt") || hk.includes("permission") || hk.includes("marketing");
    if (hasSms && hasConsent) idxCandidates.push(i);
  }
  for (const idx of idxCandidates) {
    if (idx >= 0 && idx < cols.length) {
      const v = cols[idx];
      const s = normVal(v);
      if (["false", "no", "0", "deny", "denied", "declined", "reject"].includes(s)) return false;
      if (isTruthy(v)) return true;
    }
  }
  return true; // si no se detecta, no bloqueamos import
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

    const forcedRaw = ((req.body as any)?.segmento_forzado || "").toString().toLowerCase().trim();

    // ✅ NUEVO: el front debe mandar "declara_opt_in" (checkbox)
    // Valores aceptados: true/false, "1"/"0", "yes"/"no", "si"/"no"
    const declaraOptIn = isTruthy((req.body as any)?.declara_opt_in);

    const segmentoForzado =
      forcedRaw === "cliente" || forcedRaw === "leads" || forcedRaw === "otros"
        ? (forcedRaw as "cliente" | "leads" | "otros")
        : null;

    // 🔐 Capacidad dinámica
    const { total, limite, restante } = await getCapacidadContactos(tenant_id);
    if (restante <= 0) {
      return res.status(403).json({
        error: `Ya has alcanzado tu límite de contactos (${limite}).`,
      });
    }

    // NUEVO: detectar columna de segmento y leer 'segmento_default' opcional del request
    const reqDefault = ((req.body as any)?.segmento_default || "").toString().toLowerCase();
    const segmentoDefault =
      reqDefault === "cliente" || reqDefault === "leads" || reqDefault === "otros"
        ? (reqDefault as "cliente" | "leads" | "otros")
        : ("leads" as const);

    let nuevos = 0;

    // Procesa sólo hasta el cupo disponible
    const porProcesar = dataLines.slice(0, restante);

    for (const line of porProcesar) {
      const cols = line.split(",").map((c) => c.trim());

      const firstName = pick(rawHeaders, cols, ["nombre", "first name", "firstname", "name"]);
      const lastName = pick(rawHeaders, cols, ["last name", "lastname", "apellido"]);
      const nombre = `${firstName} ${lastName}`.trim() || "Sin nombre";

      function toE164(raw: string): string | null {
        if (!raw) return null;
        const d = raw.replace(/\D/g, "");

        // USA por defecto
        if (d.length === 10) return `+1${d}`;
        if (d.length === 11 && d.startsWith("1")) return `+${d}`;
        if (d.length >= 11 && d.length <= 15) return `+${d}`;

        return null;
      }

      const telefonoRaw = pick(rawHeaders, cols, ["telefono", "phone", "tel"]);
      const telefono = toE164(telefonoRaw);

      const email = pick(rawHeaders, cols, ["email", "correo"]);

      // ✅ Segmento FINAL: si viene forzado del front, manda eso.
      // Si no viene forzado, intenta inferir. Si no, usa default.
      let segmento: Segmento =
        (segmentoForzado as Segmento) ??
        inferSegmentFromRow(line, rawHeaders, cols) ??
        segmentoDefault;

      // Reglas mínimas: al menos 1 identificador y teléfono válido si viene
      if (!telefono && !email) continue;

      // ✅ UPSERT: si hay teléfono, upsert por (tenant_id, telefono)
      // si NO hay teléfono pero sí email, upsert por (tenant_id, email)
      // Regla: nunca bajar opt-in por CSV; solo subir a true si el tenant lo declara

      const marketingOptIn = declaraOptIn;
      const optInSource = declaraOptIn ? "csv_upload" : "csv_upload_no_consent";
      const optInAt = declaraOptIn ? new Date() : null;
      const optInDeclaredBy = declaraOptIn ? tenant_id : null;

      let insertRes;

      if (telefono) {
        insertRes = await pool.query(
          `
          INSERT INTO contactos (
            tenant_id, nombre, telefono, email, segmento, fecha_creacion,
            marketing_opt_in, opt_in_source, opt_in_at, opt_in_declared_by
          )
          VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7, $8, $9)
          ON CONFLICT (tenant_id, telefono)
          DO UPDATE SET
            nombre = EXCLUDED.nombre,
            email = COALESCE(NULLIF(EXCLUDED.email, ''), contactos.email),
            segmento = EXCLUDED.segmento,

            marketing_opt_in =
              CASE
                WHEN contactos.marketing_opt_in = true THEN true
                WHEN EXCLUDED.marketing_opt_in = true THEN true
                ELSE false
              END,

            opt_in_source =
              CASE
                WHEN contactos.marketing_opt_in = true THEN contactos.opt_in_source
                WHEN EXCLUDED.marketing_opt_in = true THEN EXCLUDED.opt_in_source
                ELSE COALESCE(contactos.opt_in_source, EXCLUDED.opt_in_source)
              END,

            opt_in_at =
              CASE
                WHEN contactos.marketing_opt_in = true THEN contactos.opt_in_at
                WHEN EXCLUDED.marketing_opt_in = true THEN EXCLUDED.opt_in_at
                ELSE contactos.opt_in_at
              END,

            opt_in_declared_by =
              CASE
                WHEN contactos.marketing_opt_in = true THEN contactos.opt_in_declared_by
                WHEN EXCLUDED.marketing_opt_in = true THEN EXCLUDED.opt_in_declared_by
                ELSE contactos.opt_in_declared_by
              END
          RETURNING (xmax = 0) AS inserted
          `,
          [
            tenant_id,
            nombre,
            telefono,
            email ?? "",
            segmento,
            marketingOptIn,
            optInSource,
            optInAt,
            optInDeclaredBy,
          ]
        );
      } else if (email) {
        insertRes = await pool.query(
          `
          INSERT INTO contactos (
            tenant_id, nombre, telefono, email, segmento, fecha_creacion,
            marketing_opt_in, opt_in_source, opt_in_at, opt_in_declared_by
          )
          VALUES ($1, $2, NULL, $3, $4, NOW(), $5, $6, $7, $8)
          ON CONFLICT (tenant_id, email)
          DO UPDATE SET
            nombre = EXCLUDED.nombre,
            telefono = COALESCE(NULLIF(EXCLUDED.telefono, ''), contactos.telefono),
            segmento = EXCLUDED.segmento,

            marketing_opt_in =
              CASE
                WHEN contactos.marketing_opt_in = true THEN true
                WHEN EXCLUDED.marketing_opt_in = true THEN true
                ELSE false
              END,

            opt_in_source =
              CASE
                WHEN contactos.marketing_opt_in = true THEN contactos.opt_in_source
                WHEN EXCLUDED.marketing_opt_in = true THEN EXCLUDED.opt_in_source
                ELSE COALESCE(contactos.opt_in_source, EXCLUDED.opt_in_source)
              END,

            opt_in_at =
              CASE
                WHEN contactos.marketing_opt_in = true THEN contactos.opt_in_at
                WHEN EXCLUDED.marketing_opt_in = true THEN EXCLUDED.opt_in_at
                ELSE contactos.opt_in_at
              END,

            opt_in_declared_by =
              CASE
                WHEN contactos.marketing_opt_in = true THEN contactos.opt_in_declared_by
                WHEN EXCLUDED.marketing_opt_in = true THEN EXCLUDED.opt_in_declared_by
                ELSE contactos.opt_in_declared_by
              END
          RETURNING (xmax = 0) AS inserted
          `,
          [
            tenant_id,
            nombre,
            email,
            segmento,
            marketingOptIn,
            optInSource,
            optInAt,
            optInDeclaredBy,
          ]
        );
      } else {
        continue;
      }
      if (insertRes.rows?.[0]?.inserted) nuevos++;
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
      "SELECT nombre, telefono, email, segmento, marketing_opt_in, opt_in_source, opt_in_at FROM contactos WHERE tenant_id = $1 ORDER BY fecha_creacion DESC",
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
