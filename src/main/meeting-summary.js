'use strict';

/**
 * Gera uma Ata / Resumo estruturado em Português do Brasil (pt-BR)
 * a partir das frases capturadas na reunião do Microsoft Teams, sem custo de tokens.
 */
function generateMeetingSummaryPtBr(entries = [], metadata = {}) {
  const nowStr = new Date().toLocaleString('pt-BR');
  const totalEntries = entries.length;
  const teamsEntries = entries.filter((e) => e.source === 'system');
  const micEntries = entries.filter((e) => e.source === 'mic');

  const esCount = entries.filter((e) => e.sourceLang === 'es').length;
  const ptCount = entries.filter((e) => e.sourceLang === 'pt-BR').length;

  const actionKeywords = /\b(precisamos|vamos|fazer|entregar|prazo|tarefa|pendente|enviar|revisar|deploy|aprovar|orçamento|reunião|amanhã|semana|combinado|definido|responsável)\b/i;
  const questionKeywords = /\?|\b(como|quando|qual|quem|onde|por que|quanto)\b/i;

  const actionItems = [];
  const questionsAndDecisions = [];
  const highlights = [];

  for (const item of entries) {
    const ptText =
      item.sourceLang === 'pt-BR' ? item.sourceText : item.translatedText || item.sourceText;
    const speakerLabel = item.source === 'system' ? 'Colega (Teams)' : 'Você';
    const timeLabel = item.timestamp || '';

    if (actionKeywords.test(ptText) && actionItems.length < 10) {
      actionItems.push(`- **[${timeLabel}] ${speakerLabel}:** ${ptText}`);
    } else if (questionKeywords.test(ptText) && questionsAndDecisions.length < 8) {
      questionsAndDecisions.push(`- **[${timeLabel}] ${speakerLabel}:** ${ptText}`);
    }

    if (ptText.length > 35 && highlights.length < 12) {
      highlights.push(`- **[${timeLabel}] ${speakerLabel} (${item.sourceLang.toUpperCase()}):** ${ptText}`);
    }
  }

  const lines = [
    `# 📋 Ata & Resumo da Reunião (Microsoft Teams — PT-BR ⇄ ES)`,
    ``,
    `- **Data/Hora:** ${nowStr}`,
    `- **Duração / Intervenções:** ${totalEntries} falas registradas (${teamsEntries.length} do Teams / ${micEntries.length} suas)`,
    `- **Idiomas Detectados:** ${esCount} falas em Espanhol (` + `ES` + `) | ${ptCount} falas em Português do Brasil (` + `PT-BR` + `)`,
    metadata.context ? `- **Contexto da Reunião:** ${metadata.context}` : null,
    ``,
    `## 🎯 Principais Pontos em Português do Brasil (PT-BR)`,
    highlights.length > 0
      ? highlights.join('\n')
      : '- Nenhuma fala longa registrada até o momento.',
    ``,
    `## ✅ Ações, Prazos e Próximos Passos Identificados`,
    actionItems.length > 0
      ? actionItems.join('\n')
      : '- Nenhum item de ação explícito detectado ainda.',
    ``,
    `## ❓ Perguntas e Alinhamentos`,
    questionsAndDecisions.length > 0
      ? questionsAndDecisions.join('\n')
      : '- Nenhuma pergunta crítica destacada.',
    ``,
    `---`,
    `## 💬 Transcrição Bilíngue Completa (Original ⇄ Tradução PT-BR / ES)`,
    ``
  ].filter((line) => line !== null);

  for (const item of entries) {
    const speaker = item.source === 'system' ? '🎧 Teams' : '🎙️ Você';
    lines.push(
      `### [${item.timestamp || '--:--:--'}] ${speaker} (${item.sourceLang} → ${item.targetLang})`
    );
    lines.push(`- **Original (${item.sourceLang}):** ${item.sourceText}`);
    lines.push(`- **Tradução (${item.targetLang}):** ${item.translatedText}`);
    lines.push(``);
  }

  return lines.join('\n');
}

module.exports = {
  generateMeetingSummaryPtBr
};
