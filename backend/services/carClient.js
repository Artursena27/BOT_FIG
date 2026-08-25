/**
 * Cliente do Estudo_Car.
 *
 * Este projeto é só transporte: não conhece carro, despesa nem banco. Manda o
 * que chegou do WhatsApp e devolve o texto que vier. Toda a regra vive lá.
 */

const BASE_URL = (process.env.ESTUDO_CAR_URL || '').replace(/\/+$/, '');
const TIMEOUT_MS = Number(process.env.CAR_TIMEOUT_MS || 60000);

/**
 * @param {object} payload { from, texto? , audioBase64?, imagemBase64?, mimetype? }
 * @returns {Promise<{reply: string|null, transcricao: string|null, aguardandoConfirmacao: boolean, naoAutorizado: boolean}>}
 */
async function enviarMensagem(payload) {
  if (!BASE_URL) throw new Error('ESTUDO_CAR_URL não configurada');
  if (!process.env.INTERNAL_SECRET) throw new Error('INTERNAL_SECRET não configurada');

  // Transcrever + raciocinar leva alguns segundos; o timeout precisa ser
  // generoso, mas não infinito — senão um travamento lá prende esta requisição.
  const abort = AbortSignal.timeout(TIMEOUT_MS);

  const res = await fetch(`${BASE_URL}/api/wpp/mensagem`, {
    method: 'POST',
    signal: abort,
    headers: {
      'Content-Type': 'application/json',
      'x-internal-secret': process.env.INTERNAL_SECRET
    },
    body: JSON.stringify(payload)
  });

  // Número fora da allowlist: o silêncio é a resposta certa — responder
  // confirmaria para um estranho que este número existe e o que ele faz.
  if (res.status === 403) {
    return { reply: null, transcricao: null, aguardandoConfirmacao: false, naoAutorizado: true };
  }

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(`Estudo_Car ${res.status}: ${data.erro || data.detalhe || 'sem detalhe'}`);
  }

  return {
    reply: data.reply || null,
    transcricao: data.transcricao || null,
    aguardandoConfirmacao: data.aguardandoConfirmacao === true,
    naoAutorizado: false
  };
}

module.exports = { enviarMensagem };
