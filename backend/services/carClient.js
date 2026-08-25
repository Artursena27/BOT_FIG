/**
 * Cliente do Estudo_Car.
 *
 * Este projeto é só transporte: não conhece carro, despesa nem banco. Manda o
 * que chegou do WhatsApp e devolve o texto que vier. Toda a regra vive lá.
 */

const BASE_URL = (process.env.ESTUDO_CAR_URL || '').replace(/\/+$/, '');
const TIMEOUT_MS = Number(process.env.CAR_TIMEOUT_MS || 60000);

// Espera entre tentativas. Cobre ~17s, que é a janela típica de um redeploy do
// Estudo_Car — quando você publica o site, ele reinicia e fica fora do ar.
const BACKOFF_MS = [2000, 5000, 10000];

const espera = ms => new Promise(r => setTimeout(r, ms));

/**
 * Só repete quando o request comprovadamente NÃO chegou na aplicação: erro de
 * rede, timeout, ou 502/503/504 (o gateway do Railway respondendo por um
 * container que ainda não subiu).
 *
 * Um 500 NUNCA é repetido: ali a aplicação recebeu e processou: repetir poderia
 * lançar a mesma despesa duas vezes.
 */
function valeRepetir(res, err) {
  if (err) return true;                       // rede caiu ou estourou o timeout
  return [502, 503, 504].includes(res.status);
}

async function postComRetry(payload) {
  let ultimoErro;

  for (let tentativa = 0; tentativa <= BACKOFF_MS.length; tentativa++) {
    let res, err;
    try {
      res = await fetch(`${BASE_URL}/api/wpp/mensagem`, {
        method: 'POST',
        // Transcrever + raciocinar leva alguns segundos; o timeout precisa ser
        // generoso, mas não infinito — senão um travamento lá prende isto aqui.
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          'Content-Type': 'application/json',
          'x-internal-secret': process.env.INTERNAL_SECRET
        },
        body: JSON.stringify(payload)
      });
    } catch (e) {
      err = e;
      ultimoErro = e;
    }

    if (!valeRepetir(res, err)) return res;

    const espere = BACKOFF_MS[tentativa];
    if (espere === undefined) break;          // acabaram as tentativas

    console.warn(
      `Estudo_Car indisponível (${err ? err.message : 'HTTP ' + res.status}); ` +
      `nova tentativa em ${espere / 1000}s`
    );
    await espera(espere);
  }

  throw ultimoErro || new Error('Estudo_Car indisponível após todas as tentativas');
}

/**
 * @param {object} payload { from, texto? , audioBase64?, imagemBase64?, mimetype? }
 * @returns {Promise<{reply: string|null, transcricao: string|null, aguardandoConfirmacao: boolean, naoAutorizado: boolean}>}
 */
async function enviarMensagem(payload) {
  if (!BASE_URL) throw new Error('ESTUDO_CAR_URL não configurada');
  if (!process.env.INTERNAL_SECRET) throw new Error('INTERNAL_SECRET não configurada');

  const res = await postComRetry(payload);

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
