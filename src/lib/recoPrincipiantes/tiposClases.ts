// src/lib/recoPrincipiantes/tiposClases.ts
import pool from '../db';

export type TipoClase = {
  tipo: string;               // 'cycling' | 'funcional' | ...
  nombre?: string;
  nivel?: string;             // 'beginner' | 'intro' | 'nivel 1'...
  beginner?: boolean;
  intensidad?: 'baja'|'media'|'alta';
  duracion_min?: number;
  descripcion?: string;
};

const norm = (s: string) =>
  (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

function dedupeByTipo(items: TipoClase[]): TipoClase[] {
  const map = new Map<string, TipoClase>();
  for (const it of items) {
    const key = norm(it.tipo || '');
    if (!key) continue;
    if (!map.has(key)) map.set(key, it);
  }
  return Array.from(map.values());
}

// -------------------- helpers de introspección de schema (evitan errores en logs)
async function tableExists(table: string, schema = 'public'): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT to_regclass($1) IS NOT NULL AS exists`,
    [`${schema}.${table}`]
  );
  return !!rows[0]?.exists;
}

async function columnExists(table: string, column: string, schema = 'public'): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2 AND column_name = $3
     ) AS exists`,
    [schema, table, column]
  );
  return !!rows[0]?.exists;
}

// -------------------- parsing estructurado / heurístico desde texto
function extractStructuredBlocks(text: string): any[] {
  const out: any[] = [];
  if (!text) return out;

  let m: RegExpExecArray | null;

  // ```json ... ```
  const jsonFence = /```json\s*([\s\S]*?)```/gi;
  while ((m = jsonFence.exec(text)) !== null) {
    try { out.push(JSON.parse(m[1])); } catch {}
  }

  // JSON suelto { ... }
  const jsonLoose = /(\{[\s\S]{20,}\})/g;
  while ((m = jsonLoose.exec(text)) !== null) {
    try { out.push(JSON.parse(m[1])); } catch {}
  }

  // ```yaml ... ``` (conversión mínima a objetos)
  const yamlFence = /```yaml\s*([\s\S]*?)```/gi;
  while ((m = yamlFence.exec(text)) !== null) {
    const yaml = m[1];
    if (/-\s*tipo\s*:/i.test(yaml)) {
      const lines = yaml.split('\n');
      const items: any[] = [];
      let cur: any = null;
      for (const line of lines) {
        const l = line.trim();
        if (!l) continue;
        if (l.startsWith('-')) { if (cur) items.push(cur); cur = {}; continue; }
        const kv = l.match(/^([a-zA-Z_]+)\s*:\s*(.+)$/);
        if (kv && cur) {
          const k = kv[1].toLowerCase();
          let v: any = kv[2].trim();
          if (/^\d+$/.test(v)) v = Number(v);
          if (v === 'true') v = true;
          if (v === 'false') v = false;
          cur[k] = v;
        }
      }
      if (cur) items.push(cur);
      if (items.length) out.push(items);
    }
  }
  return out;
}

function normalizeAnyToTipos(input: any): TipoClase[] {
  if (!input) return [];
  const arr = Array.isArray(input) ? input : [input];
  const result: TipoClase[] = [];

  for (const raw of arr) {
    if (!raw || typeof raw !== 'object') continue;

    const list = Array.isArray(raw) ? raw
      : Array.isArray((raw as any).clases) ? (raw as any).clases
      : Array.isArray((raw as any).tipos) ? (raw as any).tipos
      : Array.isArray((raw as any).class_types) ? (raw as any).class_types
      : [raw];

    for (const r of list) {
      if (!r || typeof r !== 'object') continue;
      const tipo = String((r as any).tipo ?? (r as any).category ?? (r as any).nombre_tipo ?? '').trim();
      if (!tipo) continue;

      const nombre = (r as any).nombre ?? (r as any).name ?? '';
      const nivel  = (r as any).nivel  ?? (r as any).level ?? '';
      const beginner =
        (r as any).beginner === true ||
        /beginner|intro|nivel\s*1|b(á|a)sico/i.test(`${nivel} ${nombre}` || '');
      const intensidadRaw = String((r as any).intensidad ?? (r as any).intensity ?? '').toLowerCase();
      const intensidad: 'baja'|'media'|'alta'|undefined =
        intensidadRaw.includes('baja') || intensidadRaw.includes('low') ? 'baja' :
        intensidadRaw.includes('media') || intensidadRaw.includes('mid') ? 'media' :
        intensidadRaw.includes('alta') || intensidadRaw.includes('high') ? 'alta' : undefined;

      const duracion = Number((r as any).duracion_min ?? (r as any).duracion ?? (r as any).duration_min ?? (r as any).duration);
      const descripcion = (r as any).descripcion ?? (r as any).description ?? '';

      result.push({
        tipo,
        nombre: nombre ? String(nombre) : undefined,
        nivel:  nivel ? String(nivel)  : undefined,
        beginner,
        intensidad,
        duracion_min: Number.isFinite(duracion) ? duracion : undefined,
        descripcion: descripcion ? String(descripcion) : undefined
      });
    }
  }

  return result;
}

function extractHeuristicTiposFromText(text: string): TipoClase[] {
  if (!text) return [];
  const tipos: TipoClase[] = [];

  const hasCycling = /cycling|spinning|indoor\s*cycling/i.test(text);
  const hasFunc = /(funcional|functional|strength\s*training|full\s*body)/i.test(text);

  const beginnerish = /principiantes|beginner|intro|nivel\s*1/i.test(text);

  const durationMatch = text.match(/(\d{2})\s*min/i);
  const dur = durationMatch ? Number(durationMatch[1]) : undefined;

  const low  = /baja|low/i.test(text);
  const mid  = /media|mid/i.test(text);
  const high = /alta|high/i.test(text);
  const intensidad = low ? 'baja' : mid ? 'media' : high ? 'alta' : undefined;

  if (hasCycling) {
    tipos.push({
      tipo: 'cycling',
      nombre: beginnerish ? 'Cycling Principiantes' : 'Cycling',
      beginner: beginnerish || undefined,
      intensidad,
      duracion_min: dur,
    });
  }
  if (hasFunc) {
    tipos.push({
      tipo: 'funcional',
      nombre: beginnerish ? 'Funcional Básico' : 'Funcional',
      beginner: beginnerish || undefined,
      intensidad,
      duracion_min: dur,
    });
  }
  return tipos;
}

// -------------------- API principal
export async function loadTiposClases(
  tenantId: string,
  opts?: { promptBase?: string; assistantInfo?: string }
): Promise<{ tipos: TipoClase[]; fuente: string }> {
  // A) PRIMERO: intentar con lo que YA tienes en memoria (sin tocar DB)
  {
    const blobs = [opts?.promptBase, opts?.assistantInfo].filter(Boolean) as string[];
    for (const blob of blobs) {
      // 1) bloques estructurados
      const blocks = extractStructuredBlocks(blob);
      for (const b of blocks) {
        const tipos = dedupeByTipo(normalizeAnyToTipos(b));
        if (tipos.length) return { tipos, fuente: 'promptBase(structured)' };
      }
      // 2) heurístico
      const heur = extractHeuristicTiposFromText(blob);
      if (heur.length) return { tipos: dedupeByTipo(heur), fuente: 'promptBase(heuristic)' };
    }
  }

  // B) Si no hubo suerte, vamos a la DB pero SOLO si existen las fuentes

  // tenants.tipos_clases
  if (await columnExists('tenants', 'tipos_clases')) {
    const { rows } = await pool.query(
      `SELECT tipos_clases FROM tenants WHERE id = $1 LIMIT 1`, [tenantId]
    );
    const raw = rows[0]?.tipos_clases;
    if (raw) {
      try {
        const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
        const tipos = dedupeByTipo(normalizeAnyToTipos(data));
        if (tipos.length) return { tipos, fuente: 'tenants.tipos_clases' };
      } catch {}
    }
  }

  // settings('tipos_clases')
  if (await tableExists('settings')) {
    const { rows } = await pool.query(
      `SELECT value FROM settings WHERE tenant_id = $1 AND key = 'tipos_clases' LIMIT 1`, [tenantId]
    );
    const raw = rows[0]?.value;
    if (raw) {
      try {
        const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
        const tipos = dedupeByTipo(normalizeAnyToTipos(data));
        if (tipos.length) return { tipos, fuente: 'settings.tipos_clases' };
      } catch {}
    }
  }

  // class_types
  if (await tableExists('class_types')) {
    const { rows } = await pool.query(
      `SELECT tipo, nombre, nivel, beginner, intensidad, duracion_min, descripcion
       FROM class_types WHERE tenant_id = $1`, [tenantId]
    );
    if (rows?.length) return { tipos: dedupeByTipo(rows as TipoClase[]), fuente: 'class_types' };
  }

  // clases
  if (await tableExists('clases')) {
    const { rows } = await pool.query(
      `SELECT tipo, nombre, nivel, beginner, intensidad, duracion_min, descripcion
       FROM clases WHERE tenant_id = $1`, [tenantId]
    );
    if (rows?.length) return { tipos: dedupeByTipo(rows as TipoClase[]), fuente: 'clases' };
  }

  // tenants.prompt / tenants.info_asistente (solo si existen columnas)
  {
    const hasPrompt = await columnExists('tenants','prompt');
    const hasInfo   = await columnExists('tenants','info_asistente');
    if (hasPrompt || hasInfo) {
      const cols = [hasPrompt ? 'prompt' : null, hasInfo ? 'info_asistente' : null]
        .filter(Boolean)
        .join(', ');
      const { rows } = await pool.query(
        `SELECT ${cols} FROM tenants WHERE id = $1 LIMIT 1`, [tenantId]
      );
      const textParts: string[] = [];
      if (hasPrompt && rows[0]?.prompt) textParts.push(rows[0].prompt);
      if (hasInfo && rows[0]?.info_asistente) textParts.push(rows[0].info_asistente);

      for (const blob of textParts) {
        const blocks = extractStructuredBlocks(blob);
        for (const b of blocks) {
          const tipos = dedupeByTipo(normalizeAnyToTipos(b));
          if (tipos.length) return { tipos, fuente: 'tenants.prompt/info(structured)' };
        }
        const heur = extractHeuristicTiposFromText(blob);
        if (heur.length) return { tipos: dedupeByTipo(heur), fuente: 'tenants.prompt/info(heuristic)' };
      }
    }
  }

  // settings con otras keys informativas
  if (await tableExists('settings')) {
    const { rows } = await pool.query(
      `SELECT value FROM settings
        WHERE tenant_id = $1
          AND key IN ('assistant_info','informacion_asistente')
        LIMIT 1`,
      [tenantId]
    );
    const raw = rows[0]?.value;
    if (raw) {
      if (typeof raw === 'string') {
        const blocks = extractStructuredBlocks(raw);
        for (const b of blocks) {
          const tipos = dedupeByTipo(normalizeAnyToTipos(b));
          if (tipos.length) return { tipos, fuente: 'settings.assistant_info(structured)' };
        }
        const heur = extractHeuristicTiposFromText(raw);
        if (heur.length) return { tipos: dedupeByTipo(heur), fuente: 'settings.assistant_info(heuristic)' };
      } else {
        const tipos = dedupeByTipo(normalizeAnyToTipos(raw));
        if (tipos.length) return { tipos, fuente: 'settings.assistant_info(json)' };
      }
    }
  }

  // Nada encontrado
  return { tipos: [], fuente: 'vacio' };
}
