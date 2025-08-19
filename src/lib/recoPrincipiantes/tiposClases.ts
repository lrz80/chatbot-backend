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

// ---------- Utils de parsing ----------
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

// Intenta encontrar bloques JSON o YAML en texto
function extractStructuredBlocks(text: string): any[] {
  const out: any[] = [];
  if (!text) return out;

  // --- JSON entre ```json ... ``` ---
  const jsonFence = /```json\s*([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  while ((m = jsonFence.exec(text)) !== null) {
    try {
      const obj = JSON.parse(m[1]);
      out.push(obj);
    } catch {}
  }

  // --- JSON crudo { ... } sospechoso ---
  const jsonLoose = /(\{[\s\S]{20,}\})/g; // heurístico
  while ((m = jsonLoose.exec(text)) !== null) {
    try {
      const obj = JSON.parse(m[1]);
      out.push(obj);
    } catch {}
  }

  // --- YAML en ```yaml ... ``` (simple) ---
  // No parseamos YAML con lib; intentamos una conversión mínima a JSON si detectamos listas
  const yamlFence = /```yaml\s*([\s\S]*?)```/gi;
  while ((m = yamlFence.exec(text)) !== null) {
    const yaml = m[1];
    // Heurística: items de lista con "- tipo:" que podemos convertir rápido
    if (/-\s*tipo\s*:/i.test(yaml)) {
      const lines = yaml.split('\n');
      const items: any[] = [];
      let cur: any = null;
      for (const line of lines) {
        const l = line.trim();
        if (l.startsWith('-')) {
          if (cur) items.push(cur);
          cur = {};
          continue;
        }
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

// Normaliza objetos diversos a TipoClase[]
function normalizeAnyToTipos(input: any): TipoClase[] {
  if (!input) return [];
  const arr = Array.isArray(input) ? input : [input];
  const result: TipoClase[] = [];

  for (const raw of arr) {
    if (!raw || typeof raw !== 'object') continue;

    // Soportar estructuras tipo { clases: [...] }
    const list = Array.isArray(raw) ? raw
      : Array.isArray(raw.clases) ? raw.clases
      : Array.isArray(raw.tipos) ? raw.tipos
      : Array.isArray(raw.class_types) ? raw.class_types
      : [raw];

    for (const r of list) {
      if (!r || typeof r !== 'object') continue;
      const tipo = String(r.tipo ?? r.category ?? r.nombre_tipo ?? '').trim();
      if (!tipo) continue;

      const nombre = r.nombre ?? r.name ?? '';
      const nivel  = r.nivel ?? r.level ?? '';
      const beginner =
        r.beginner === true ||
        /beginner|intro|nivel\s*1|b(á|a)sico/i.test(`${nivel} ${nombre}` || '');
      const intensidadRaw = String(r.intensidad ?? r.intensity ?? '').toLowerCase();
      const intensidad: 'baja'|'media'|'alta'|undefined =
        intensidadRaw.includes('baja') || intensidadRaw.includes('low') ? 'baja' :
        intensidadRaw.includes('media') || intensidadRaw.includes('mid') ? 'media' :
        intensidadRaw.includes('alta') || intensidadRaw.includes('high') ? 'alta' : undefined;

      const duracion = Number(r.duracion_min ?? r.duracion ?? r.duration_min ?? r.duration);
      const descripcion = r.descripcion ?? r.description ?? '';

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

// Heurístico simple desde texto libre (si no hay bloque estructurado)
function extractHeuristicTiposFromText(text: string): TipoClase[] {
  const t = norm(text);
  const tipos: TipoClase[] = [];

  const hasCycling = /cycling|spinning|indoor\s*cycling/i.test(text);
  const hasFunc = /(funcional|functional|strength\s*training|full\s*body)/i.test(text);

  if (hasCycling) {
    tipos.push({
      tipo: 'cycling',
      nombre: /principiantes|beginner|intro|nivel\s*1/i.test(text)
        ? 'Cycling Principiantes'
        : 'Cycling',
      beginner: /principiantes|beginner|intro|nivel\s*1/i.test(text) || undefined,
      intensidad:
        /baja|low/i.test(text) ? 'baja' :
        /media|mid/i.test(text) ? 'media' :
        /alta|high/i.test(text) ? 'alta' : undefined,
      duracion_min: /(\d{2})\s*min/i.test(text) ? Number((text.match(/(\d{2})\s*min/i) as RegExpMatchArray)[1]) : undefined,
      descripcion: undefined
    });
  }

  if (hasFunc) {
    tipos.push({
      tipo: 'funcional',
      nombre: /principiantes|beginner|intro|nivel\s*1/i.test(text)
        ? 'Funcional Básico'
        : 'Funcional',
      beginner: /principiantes|beginner|intro|nivel\s*1/i.test(text) || undefined,
      intensidad:
        /baja|low/i.test(text) ? 'baja' :
        /media|mid/i.test(text) ? 'media' :
        /alta|high/i.test(text) ? 'alta' : undefined,
      duracion_min: /(\d{2})\s*min/i.test(text) ? Number((text.match(/(\d{2})\s*min/i) as RegExpMatchArray)[1]) : undefined,
      descripcion: undefined
    });
  }

  return tipos;
}

// ---------- Carga desde DB (múltiples fuentes) ----------
export async function loadTiposClases(tenantId: string): Promise<TipoClase[]> {
  // 1) JSON directo en tenants.tipos_clases
  try {
    const { rows } = await pool.query(
      `SELECT tipos_clases FROM tenants WHERE id = $1 LIMIT 1`, [tenantId]
    );
    const raw = rows[0]?.tipos_clases;
    if (raw) {
      const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (Array.isArray(data) && data.length) return dedupeByTipo(normalizeAnyToTipos(data));
    }
  } catch (e) { /* opcional log */ }

  // 2) settings(key='tipos_clases')
  try {
    const { rows } = await pool.query(
      `SELECT value FROM settings WHERE tenant_id = $1 AND key = 'tipos_clases' LIMIT 1`, [tenantId]
    );
    const raw = rows[0]?.value;
    if (raw) {
      const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (Array.isArray(data) && data.length) return dedupeByTipo(normalizeAnyToTipos(data));
    }
  } catch (e) { /* opcional log */ }

  // 3) Tablas relacionales
  try {
    const { rows } = await pool.query(
      `SELECT tipo, nombre, nivel, beginner, intensidad, duracion_min, descripcion
       FROM class_types WHERE tenant_id = $1`, [tenantId]
    );
    if (rows?.length) return dedupeByTipo(rows as TipoClase[]);
  } catch (e) {}

  try {
    const { rows } = await pool.query(
      `SELECT tipo, nombre, nivel, beginner, intensidad, duracion_min, descripcion
       FROM clases WHERE tenant_id = $1`, [tenantId]
    );
    if (rows?.length) return dedupeByTipo(rows as TipoClase[]);
  } catch (e) {}

  // 4) ⬇️ NUEVO: leer texto desde tenants.prompt y tenants.info_asistente
  let promptText = '';
  let infoText = '';

  try {
    const { rows } = await pool.query(
      // ⚠️ Ajusta nombres si en tu schema se llaman distinto
      `SELECT prompt, info_asistente
         FROM tenants
        WHERE id = $1
        LIMIT 1`,
      [tenantId]
    );
    promptText = rows[0]?.prompt || '';
    // Si tu columna se llama 'informacion_asistente' o similar, cámbiala arriba
    infoText   = rows[0]?.info_asistente || '';
  } catch (e) { /* opcional log */ }

  // 4.1 Intentar bloques estructurados en prompt / info
  for (const blob of [promptText, infoText]) {
    if (!blob) continue;
    const blocks = extractStructuredBlocks(blob);
    for (const b of blocks) {
      const tipos = normalizeAnyToTipos(b);
      if (tipos.length) return dedupeByTipo(tipos);
    }
  }

  // 4.2 Heurístico por palabras clave si no hay bloques
  const heurFromPrompt = promptText ? extractHeuristicTiposFromText(promptText) : [];
  const heurFromInfo   = infoText ? extractHeuristicTiposFromText(infoText) : [];
  const merged = dedupeByTipo([...heurFromPrompt, ...heurFromInfo]);
  if (merged.length) return merged;

  // 5) (Opcional) settings con otra key
  try {
    const { rows } = await pool.query(
      `SELECT value FROM settings WHERE tenant_id = $1 AND key IN ('assistant_info','informacion_asistente') LIMIT 1`, [tenantId]
    );
    const raw = rows[0]?.value;
    if (typeof raw === 'string') {
      const blocks = extractStructuredBlocks(raw);
      for (const b of blocks) {
        const tipos = normalizeAnyToTipos(b);
        if (tipos.length) return dedupeByTipo(tipos);
      }
      const heur = extractHeuristicTiposFromText(raw);
      if (heur.length) return dedupeByTipo(heur);
    } else if (raw) {
      const tipos = normalizeAnyToTipos(raw);
      if (tipos.length) return dedupeByTipo(tipos);
    }
  } catch (e) {}

  // Sin datos
  return [];
}
