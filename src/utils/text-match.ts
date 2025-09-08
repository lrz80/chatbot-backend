// 📁 src/utils/text-match.ts
const STOP_ES = new Set([
    'el','la','los','las','un','una','unos','unas','de','del','al','a','que','y','o',
    'es','son','soy','eres','esta','estan','como','cual','cuales','donde','quien',
    'cuando','por','para','con','mi','tu','su','sus','lo','en','cuanto','cuánto'
  ]);
  const STOP_EN = new Set([
    'the','a','an','of','to','in','on','for','and','or','is','are','am','be','i','you','we','they','how','much'
  ]);
  
  export function normalize(s: string) {
    return (s || '')
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  
  function tokensNoStop(s: string, lang: 'es'|'en'|'auto' = 'auto'): string[] {
    const toks = normalize(s).split(' ').filter(Boolean);
    const stop = lang === 'en' ? STOP_EN : STOP_ES; // default ES
    return toks.filter(w => !stop.has(w));
  }
  
  /** Jaccard con stopwords fuera */
  function jaccard(a: string, b: string, lang: 'es'|'en'|'auto' = 'auto'): number {
    const A = new Set(tokensNoStop(a, lang));
    const B = new Set(tokensNoStop(b, lang));
    const inter = [...A].filter(x => B.has(x)).length;
    const union = new Set([...A, ...B]).size || 1;
    return inter / union;
  }
  
  /** Si el patrón (B) es subconjunto de A → score alto */
  function tokenSetScore(a: string, b: string, lang: 'es'|'en'|'auto' = 'auto'): number {
    const A = new Set(tokensNoStop(a, lang));
    const B = new Set(tokensNoStop(b, lang));
    if (B.size === 0) return 0;
    let hits = 0; for (const t of B) if (A.has(t)) hits++;
    return hits / B.size;
  }
  
  /** Mejor patrón: mezcla de jaccard, subset y contains */
  export function bestPatternScore(
    userMsg: string,
    patrones: string[],
    umbral = 0.55,
    lang: 'es'|'en'|'auto' = 'auto'
  ) {
    let best = { score: 0, pattern: '' };
    for (const p of (patrones || [])) {
      const sJ  = jaccard(userMsg, p, lang);
      const sTS = tokenSetScore(userMsg, p, lang);
      const sIn = normalize(userMsg).includes(normalize(p)) ? 1 : 0;
      const s = Math.max(sJ, sTS, sIn);
      if (s > best.score) best = { score: s, pattern: p };
    }
    return best.score >= umbral ? best : null;
  }
  