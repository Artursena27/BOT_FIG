/**
 * Clientes de IA no formato da OpenAI.
 *
 * Gemini, Groq, DeepSeek e a própria OpenAI falam o mesmo protocolo; muda só
 * o endereço, a chave e o nome do modelo. Cada papel (conversa, transcrição,
 * imagem) tem o seu provedor, configurado por variável de ambiente — trocar
 * não exige mudar código. Sem configuração, cai na OpenAI com OPENAI_API_KEY.
 *
 * Exemplo de custo zero:
 *   LLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/   (Gemini)
 *   TRANSCRICAO_BASE_URL=https://api.groq.com/openai/v1                     (Groq)
 */

import OpenAI from 'openai';

const clientes = {};

function cliente(papel) {
  if (!clientes[papel]) {
    const P = papel.toUpperCase();
    clientes[papel] = new OpenAI({
      apiKey: process.env[`${P}_API_KEY`] || process.env.OPENAI_API_KEY,
      baseURL: process.env[`${P}_BASE_URL`] || undefined,
      // O SDK repete sozinho em 429/5xx, esperando entre tentativas. Com
      // modelos reserva é melhor desistir cedo e trocar de modelo.
      maxRetries: papel === 'llm' && process.env.LLM_MODELOS_RESERVA ? 0 : 2
    });
  }
  return clientes[papel];
}

export const llm = () => cliente('llm');
export const transcritor = () => cliente('transcricao');
export const geradorDeImagem = () => cliente('imagem');

export const MODELO_CHAT = () => process.env.LLM_MODELO || 'gpt-5.6-terra';
export const MODELOS_RESERVA = () =>
  (process.env.LLM_MODELOS_RESERVA || '').split(',').map(m => m.trim()).filter(Boolean);
export const MODELO_TRANSCRICAO = () => process.env.TRANSCRICAO_MODELO || 'gpt-transcribe';
export const MODELO_IMAGEM = () => process.env.IMAGEM_MODELO || 'gpt-image-1-mini';

/**
 * Gerar figurinha do zero precisa de um modelo de imagem, e não há opção
 * grátis confiável. Sem chave para isso, a ferramenta avisa em vez de falhar.
 */
export const temGeradorDeImagem = () =>
  Boolean(process.env.IMAGEM_API_KEY || process.env.OPENAI_API_KEY);
