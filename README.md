# 🎧 Transync AI Clone — Edição PT-BR ⇄ Espanhol (Microsoft Teams)

Clone desktop **100% gratuito e sem consumo de tokens pagos** do **Transync AI (v2.7.0)**, projetado especificamente para reuniões online no **Microsoft Teams** onde participantes alternam entre **Espanhol (`es-419` / `es-ES`)** e **Português do Brasil (`pt-BR`)**.

Construído a partir da engenharia reversa da aplicação original com o [REA (`rea-agents` v6.8.0)](https://github.com/morluto/rea).

---

## ✨ Diferenciais em Relação ao Transync AI Original

| Recurso | Transync AI Oficial | Transync PT-BR (Este Projeto) |
| :--- | :--- | :--- |
| **Português do Brasil (`pt-BR`)** | ❌ Apenas `pt-PT` / `pt` genérico | ✅ **`pt-BR` Nativo** + Normalizador anti-lusitanismos (`tela`, `equipe`, `arquivo`, `planejamento`, `orçamento`) |
| **Custo / Tokens** | ❌ Pago por minuto após 40 min | ✅ **100% Gratuito e Ilimitado** (Whisper Local ONNX + WebSpeech + Google GTX / MyMemory Free) |
| **Captura do Microsoft Teams** | ✅ WASAPI Process Loopback (`exclude-tree`) | ✅ **Mesmo motor WASAPI Process Loopback (`exclude-tree`)** sem precisar de VB-Cable e sem eco |
| **Separação de Canais** | ✅ Sistema vs Microfone | ✅ **Canal 1: Colegas (Teams)** + **Canal 2: Você (Microfone)** com medidores VU independentes |
| **Legenda Flutuante (PiP)** | ✅ Always-on-Top transparente | ✅ **Janela PiP Transparente Always-on-Top** sobre o Teams com controle de fonte |
| **Barra de Resposta Rápida** | ❌ Não possui | ✅ Digite em `PT-BR` e veja/ouça/copie instantaneamente como responder em `Espanhol` no Teams |
| **Ata / Resumo em `PT-BR`** | 💰 Pago via crédito IA | ✅ **Geração gratuita instantânea de Ata e Exportação Bilíngue (`.md`, `.txt`, `.json`)** |

---

## 🏗️ Arquitetura Técnica

1. **Captura Nativa do Áudio do Sistema sem Eco (`src/main/audio-loopback.js`):**
   - Utiliza a API `ActivateAudioInterfaceAsync` do Windows 10/11 (`WASAPI Process Loopback` em modo `exclude-tree`) através do helper `transync-win-process-loopback-helper.exe`.
   - Captura em `16.000 Hz` mono `Int16 PCM` todo o áudio reproduzido pelo **Microsoft Teams**, excluindo o próprio aplicativo para que a leitura em voz alta (`TTS`) nunca gere loop infinito.
2. **Detecção de Atividade de Voz em Tempo Real (`src/main/vad-segmenter.js`):**
   - Mantém um buffer *pre-roll* de `320ms` para nunca cortar o início das frases (`"Hola"`, `"Bom dia"`, `"Entonces"`).
   - Emite transcrições e traduções **parciais em tempo real** a cada `1,6s` enquanto o colega ainda está falando no Teams, e consolida a frase final assim que detecta uma pausa natural (`~540ms`).
3. **Motor STT Híbrido Gratuito (`src/main/stt-engine.js` & `src/main/whisper-worker.js`):**
   - **Canal Sistema (Teams):** Executa inferência local com `@xenova/transformers` (`Xenova/whisper-tiny`, `Xenova/whisper-base` ou `Xenova/whisper-small`) em uma `Worker Thread` dedicada do Node.js.
   - **Canal Microfone (Você):** Combina `Web Speech API` (`pt-BR`) de baixíssima latência com fallback automático para o `Whisper Local ONNX`.
   - **Modo Opcional Groq Free Tier:** Suporta opcionalmente chave gratuita `whisper-large-v3-turbo` sem cartão de crédito.
4. **Tradutor Bidirecional `PT-BR ⇄ ES` (`src/main/translator.js`):**
   - Detecta automaticamente se a fala foi em **Espanhol (`es`)** ou **Português do Brasil (`pt-BR`)**:
     - Fala em **Espanhol (`es`)** → Traduzida para **Português do Brasil (`pt-BR`)**.
     - Fala em **Português do Brasil (`pt-BR`)** → Traduzida para **Espanhol (`es`)**.
   - Aplica glossário corporativo customizável e pós-processamento específico para `pt-BR`.

---

## 🚀 Como Executar no Windows

```bash
# 1. Instalar dependências
npm install

# 2. Executar os testes automatizados
npm test

# 3. Iniciar o aplicativo Desktop (Electron)
npm start
```

> **Nota sobre os Helpers Nativos do Windows:**
> O aplicativo procura automaticamente `transync-win-process-loopback-helper.exe` e `transync-win-pip-z-order-helper.exe` em `resources/win-native-helpers/` ou na instalação local `C:\Program Files\Transync AI\resources\win-native-helpers\`.
