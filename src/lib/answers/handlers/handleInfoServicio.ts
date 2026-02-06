import type { Pool } from "pg";

type Lang = "es" | "en";

export async function handleInfoServicio(args: {
  pool: Pool;
  tenantId: string;
  tenant: any; // usa tu tipo si lo tienes (TenantRow)
  idioma: Lang;
  canal: string;

  // condiciones de orquestación (para no romper booking/awaiting)
  inBooking: boolean;
  awaiting: any;
  detectedIntent: string | null;
}) {
  const {
    pool,
    tenantId,
    tenant,
    idioma,
    inBooking,
    awaiting,
    detectedIntent,
  } = args;

  // Solo actúa si corresponde
  if (inBooking) return { handled: false as const };
  if (awaiting) return { handled: false as const };
  if (detectedIntent !== "info_servicio") return { handled: false as const };

  // 1) Intentar DB services (si existe tabla/columnas)
  let services: Array<{ name: string }> = [];
  try {
    const r = await pool.query(
      `
      SELECT name
      FROM services
      WHERE tenant_id = $1
        AND (active IS NULL OR active = TRUE)
      ORDER BY name ASC
      LIMIT 6
      `,
      [tenantId]
    );
    services = (r.rows || [])
      .map((x: any) => ({ name: String(x?.name || "").trim() }))
      .filter((x) => x.name);
  } catch {
    // Si no existe la tabla o falla, no inventamos; caemos a prompt/tenant info
    services = [];
  }

  const tenantName = String(tenant?.name || tenant?.nombre || "nuestro negocio").trim();

  // Si hay services, menú corto (determinista)
  if (services.length) {
    const list = services.slice(0, 5).map((s, i) => `${i + 1}) ${s.name}`).join("\n");

    const text =
      idioma === "en"
        ? `Sure 😊 Here are the main options at ${tenantName}:\n${list}\n\nReply with the number (1-${Math.min(5, services.length)}) and I’ll send details.`
        : `¡Claro! 😊 Estas son las opciones principales en ${tenantName}:\n${list}\n\nRespóndeme con el número (1-${Math.min(5, services.length)}) y te doy los detalles.`;

    return {
      handled: true as const,
      text,
      source: "info_servicio_handler_db",
      intent: "info_servicio",
    };
  }

  // 2) Fallback a info del tenant (lo que “antes funcionaba”)
  // NO inventamos: solo guiamos a qué info quiere
  const text =
    idioma === "en"
      ? `Sure 😊 What would you like info about at ${tenantName}? (pricing/packages, schedule, or booking)`
      : `Claro 😊 ¿Qué información quieres sobre ${tenantName}? (precios/paquetes, horarios o agendar)`;

  return {
    handled: true as const,
    text,
    source: "info_servicio_handler_tenant",
    intent: "info_servicio",
  };
}
