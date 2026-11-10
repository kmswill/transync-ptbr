'use strict';

/**
 * Dicionário de normalização de Português Europeu (pt-PT) -> Português do Brasil (pt-BR)
 * para garantir que nenhuma saída em português venha com vocabulário de Portugal.
 */
const PT_PT_TO_PT_BR_REPLACEMENTS = [
  [/(?<![\p{L}\p{N}_])ecrãs(?![\p{L}\p{N}_])/giu, 'telas'],
  [/(?<![\p{L}\p{N}_])ecrã(?![\p{L}\p{N}_])/giu, 'tela'],
  [/(?<![\p{L}\p{N}_])partilhar(?![\p{L}\p{N}_])/giu, 'compartilhar'],
  [/(?<![\p{L}\p{N}_])equipas(?![\p{L}\p{N}_])/giu, 'equipes'],
  [/(?<![\p{L}\p{N}_])equipa(?![\p{L}\p{N}_])/giu, 'equipe'],
  [/(?<![\p{L}\p{N}_])ficheiros(?![\p{L}\p{N}_])/giu, 'arquivos'],
  [/(?<![\p{L}\p{N}_])ficheiro(?![\p{L}\p{N}_])/giu, 'arquivo'],
  [/(?<![\p{L}\p{N}_])utilizadores(?![\p{L}\p{N}_])/giu, 'usuários'],
  [/(?<![\p{L}\p{N}_])utilizador(?![\p{L}\p{N}_])/giu, 'usuário'],
  [/(?<![\p{L}\p{N}_])planeamento(?![\p{L}\p{N}_])/giu, 'planejamento'],
  [/(?<![\p{L}\p{N}_])orçamentação(?![\p{L}\p{N}_])/giu, 'orçamento'],
  [/(?<![\p{L}\p{N}_])faturação(?![\p{L}\p{N}_])/giu, 'faturamento'],
  [/(?<![\p{L}\p{N}_])aplicação(?![\p{L}\p{N}_])/giu, 'aplicativo'],
  [/(?<![\p{L}\p{N}_])computador portátil(?![\p{L}\p{N}_])/giu, 'notebook'],
  [/(?<![\p{L}\p{N}_])telemóvel(?![\p{L}\p{N}_])/giu, 'celular'],
  [/(?<![\p{L}\p{N}_])autocarro(?![\p{L}\p{N}_])/giu, 'ônibus'],
  [/(?<![\p{L}\p{N}_])comboio(?![\p{L}\p{N}_])/giu, 'trem'],
  [/(?<![\p{L}\p{N}_])pequeno-almoço(?![\p{L}\p{N}_])/giu, 'café da manhã'],
  [/(?<![\p{L}\p{N}_])está a fazer(?![\p{L}\p{N}_])/giu, 'está fazendo'],
  [/(?<![\p{L}\p{N}_])estamos a fazer(?![\p{L}\p{N}_])/giu, 'estamos fazendo'],
  [/(?<![\p{L}\p{N}_])estou a fazer(?![\p{L}\p{N}_])/giu, 'estou fazendo'],
  [/(?<![\p{L}\p{N}_])estão a fazer(?![\p{L}\p{N}_])/giu, 'estão fazendo'],
  [/(?<![\p{L}\p{N}_])está a falar(?![\p{L}\p{N}_])/giu, 'está falando'],
  [/(?<![\p{L}\p{N}_])estamos a trabalhar(?![\p{L}\p{N}_])/giu, 'estamos trabalhando'],
  [/(?<![\p{L}\p{N}_])estou a ver(?![\p{L}\p{N}_])/giu, 'estou vendo'],
  [/(?<![\p{L}\p{N}_])estamos a ver(?![\p{L}\p{N}_])/giu, 'estamos vendo'],
  [/(?<![\p{L}\p{N}_])a nível de(?![\p{L}\p{N}_])/giu, 'em termos de'],
  [/(?<![\p{L}\p{N}_])submeter(?![\p{L}\p{N}_])/giu, 'enviar'],
  [/(?<![\p{L}\p{N}_])registar(?![\p{L}\p{N}_])/giu, 'registrar'],
  [/(?<![\p{L}\p{N}_])registo(?![\p{L}\p{N}_])/giu, 'registro'],
  [/(?<![\p{L}\p{N}_])contacto(?![\p{L}\p{N}_])/giu, 'contato'],
  [/(?<![\p{L}\p{N}_])contactos(?![\p{L}\p{N}_])/giu, 'contatos'],
  [/(?<![\p{L}\p{N}_])facto(?![\p{L}\p{N}_])/giu, 'fato'],
  [/(?<![\p{L}\p{N}_])activo(?![\p{L}\p{N}_])/giu, 'ativo'],
  [/(?<![\p{L}\p{N}_])projecto(?![\p{L}\p{N}_])/giu, 'projeto']
];

const SPANISH_WORDS = new Set([
  'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'pero', 'porque',
  'muy', 'está', 'están', 'estamos', 'tiene', 'tienen', 'tenemos', 'hacer',
  'haciendo', 'nosotros', 'ustedes', 'vosotros', 'ellos', 'ellas', 'reunión',
  'equipo', 'ahora', 'bueno', 'buenos', 'buenas', 'vale', 'entonces', 'sí',
  'qué', 'cómo', 'cuándo', 'dónde', 'quién', 'también', 'todavía', 'siempre',
  'nunca', 'después', 'antes', 'hoy', 'mañana', 'ayer', 'semana', 'mes',
  'año', 'presupuesto', 'facturación', 'despliegue', 'pantalla', 'archivo',
  'correo', 'clientes', 'proyecto', 'tareas', 'pendientes', 'listo', 'claro',
  'gracias', 'hola', 'muchas', 'mucho', 'poco', 'puede', 'pueden', 'podemos',
  'quiero', 'queremos', 'necesito', 'necesitamos', 'vamos', 'hablar', 'decir'
]);

const PORTUGUESE_BR_WORDS = new Set([
  'o', 'os', 'um', 'uma', 'uns', 'umas', 'mas', 'porque', 'porquê', 'muito',
  'está', 'estão', 'estamos', 'tem', 'têm', 'temos', 'fazer', 'fazendo',
  'nós', 'você', 'vocês', 'gente', 'eles', 'elas', 'reunião', 'equipe',
  'agora', 'bom', 'boa', 'bons', 'boas', 'então', 'sim', 'não', 'que',
  'como', 'quando', 'onde', 'quem', 'também', 'ainda', 'sempre', 'nunca',
  'depois', 'antes', 'hoje', 'amanhã', 'ontem', 'orçamento', 'faturamento',
  'tela', 'arquivo', 'clientes', 'projeto', 'tarefas', 'pendentes', 'pronto',
  'obrigado', 'obrigada', 'olá', 'oi', 'pode', 'podem', 'podemos', 'quero',
  'queremos', 'preciso', 'precisamos', 'falar', 'dizer', 'isso', 'isto',
  'aqui', 'aí', 'lá', 'pra', 'pro', 'tá', 'né'
]);

/**
 * Glossário corporativo/técnico padrão para reuniões no Microsoft Teams (ES ⇄ PT-BR).
 */
const DEFAULT_GLOSSARY = [
  { source: 'presupuesto', target: 'orçamento', direction: 'es->pt-BR' },
  { source: 'facturación', target: 'faturamento', direction: 'es->pt-BR' },
  { source: 'pantalla', target: 'tela', direction: 'es->pt-BR' },
  { source: 'compartir pantalla', target: 'compartilhar a tela', direction: 'es->pt-BR' },
  { source: 'despliegue', target: 'deploy', direction: 'es->pt-BR' },
  { source: 'equipo', target: 'equipe', direction: 'es->pt-BR' },
  { source: 'reunión diaria', target: 'daily', direction: 'es->pt-BR' },
  { source: 'ordenador', target: 'computador', direction: 'es->pt-BR' },
  { source: 'computadora', target: 'computador', direction: 'es->pt-BR' }
];

/**
 * Detecta se um texto está em Espanhol ('es') ou Português do Brasil ('pt-BR').
 */
function detectLanguagePtBrOrEs(text, hint = 'auto') {
  const clean = String(text || '').trim();
  if (!clean) {
    return hint === 'es' || hint === 'es-419' || hint === 'es-ES' ? 'es' : 'pt-BR';
  }

  let esScore = 0;
  let ptScore = 0;

  // Marcadores ortográficos exclusivos ou fortes
  if (/[ñ¿¡]/i.test(clean)) esScore += 4;
  if (/[ãõç]/i.test(clean)) ptScore += 4;
  if (/\b\w+ción\b/i.test(clean)) esScore += 2.5;
  if (/\b\w+ções\b|\b\w+ção\b/i.test(clean)) ptScore += 2.5;
  if (/\b(nh|lh)/i.test(clean)) ptScore += 1.5;
  if (/\b(ue|ie)\w+/i.test(clean)) esScore += 0.8;

  const tokens = clean
    .toLowerCase()
    .replace(/[^\p{L}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);

  for (const token of tokens) {
    if (SPANISH_WORDS.has(token)) esScore += 1.5;
    if (PORTUGUESE_BR_WORDS.has(token)) ptScore += 1.5;
  }

  if (esScore === ptScore) {
    if (hint && hint.startsWith('es')) return 'es';
    if (hint && hint.startsWith('pt')) return 'pt-BR';
  }

  return esScore > ptScore ? 'es' : 'pt-BR';
}

/**
 * Aplica normalização explícita para Português do Brasil (pt-BR).
 */
function normalizeToBrazilianPortuguese(text) {
  let out = String(text || '');
  for (const [pattern, replacement] of PT_PT_TO_PT_BR_REPLACEMENTS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * Aplica termos do glossário customizado na tradução final.
 */
function applyGlossary(text, direction, customGlossary = []) {
  let out = String(text || '');
  const combined = [...(Array.isArray(customGlossary) ? customGlossary : []), ...DEFAULT_GLOSSARY];
  for (const entry of combined) {
    if (!entry || !entry.source || !entry.target) continue;
    if (entry.direction && entry.direction !== 'both' && entry.direction !== direction) {
      continue;
    }
    const escaped = entry.source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'giu');
    out = out.replace(regex, entry.target);
  }
  return out;
}

/**
 * Traduz gratuitamente entre Espanhol (es) e Português do Brasil (pt-BR)
 * sem consumir tokens pagos, usando endpoint GTX gratuito + fallback MyMemory.
 */
async function translateBidirectionalPtBrEs(text, options = {}) {
  const cleanText = String(text || '').trim();
  if (!cleanText) {
    return {
      sourceText: '',
      translatedText: '',
      sourceLang: 'es',
      targetLang: 'pt-BR',
      provider: 'noop'
    };
  }

  const hintLang = options.sourceLangHint || 'auto';
  const localDetected = detectLanguagePtBrOrEs(cleanText, hintLang);
  const sourceLang =
    options.forceSourceLang && options.forceSourceLang !== 'auto'
      ? options.forceSourceLang.startsWith('es')
        ? 'es'
        : 'pt-BR'
      : localDetected;

  const targetLang = sourceLang === 'es' ? 'pt-BR' : 'es';
  const direction = `${sourceLang}->${targetLang}`;

  // 1. Tenta Google Translate GTX (gratuito, sem chave, suporte explícito a pt-BR e es)
  try {
    const slParam = sourceLang === 'es' ? 'es' : 'pt';
    const tlParam = targetLang === 'pt-BR' ? 'pt-BR' : 'es';
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${slParam}&tl=${tlParam}&dt=t&q=${encodeURIComponent(cleanText)}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4500);
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      },
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (response.ok) {
      const data = await response.json();
      const segments = Array.isArray(data?.[0]) ? data[0] : [];
      let translated = segments.map((seg) => seg?.[0] || '').join('').trim();

      if (translated) {
        if (targetLang === 'pt-BR') {
          translated = normalizeToBrazilianPortuguese(translated);
        }
        translated = applyGlossary(translated, direction, options.glossary);
        return {
          sourceText: cleanText,
          translatedText: translated,
          sourceLang,
          targetLang,
          provider: 'google-gtx-free'
        };
      }
    }
  } catch {
    // Passa para o fallback gratuito MyMemory
  }

  // 2. Fallback: MyMemory Translated Free API
  try {
    const langPair = `${sourceLang === 'es' ? 'es-ES' : 'pt-BR'}|${targetLang === 'pt-BR' ? 'pt-BR' : 'es-ES'}`;
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(cleanText)}&langpair=${encodeURIComponent(langPair)}`;
    const response = await fetch(url);
    if (response.ok) {
      const data = await response.json();
      let translated = String(data?.responseData?.translatedText || '').trim();
      if (translated) {
        if (targetLang === 'pt-BR') {
          translated = normalizeToBrazilianPortuguese(translated);
        }
        translated = applyGlossary(translated, direction, options.glossary);
        return {
          sourceText: cleanText,
          translatedText: translated,
          sourceLang,
          targetLang,
          provider: 'mymemory-free'
        };
      }
    }
  } catch {
    // Fallback offline por glossário caso não haja internet
  }

  // 3. Fallback Offline Local
  let fallbackText = applyGlossary(cleanText, direction, options.glossary);
  if (targetLang === 'pt-BR') {
    fallbackText = normalizeToBrazilianPortuguese(fallbackText);
  }
  return {
    sourceText: cleanText,
    translatedText: fallbackText,
    sourceLang,
    targetLang,
    provider: 'offline-glossary-fallback'
  };
}

module.exports = {
  detectLanguagePtBrOrEs,
  normalizeToBrazilianPortuguese,
  applyGlossary,
  translateBidirectionalPtBrEs,
  DEFAULT_GLOSSARY
};
