/**
 * Envio de aviso partindo do sistema (não em resposta a uma mensagem).
 *
 * A Cloud API só entrega texto livre dentro da janela de 24h desde a última
 * mensagem DO USUÁRIO. Fora dela a Meta recusa com 131047 e nada é entregue —
 * seria preciso um template aprovado. Aqui a gente distingue esse caso de um
 * erro real, para o Estudo_Car poder guardar o aviso e entregar no próximo
 * contato em vez de perdê-lo.
 */

const { sendText } = require('./waClient');

// "Message failed to send because more than 24 hours have passed since the
// customer last replied" — e os primos dele.
const FORA_DA_JANELA = [131047, 131051, 470];

function codigoDoErro(mensagem) {
  const m = String(mensagem).match(/"code"\s*:\s*(\d+)/);
  return m ? Number(m[1]) : null;
}

/**
 * @returns {Promise<{entregue: boolean, foraDaJanela: boolean, erro?: string}>}
 */
async function notificar(para, texto) {
  try {
    await sendText(para, texto);
    return { entregue: true, foraDaJanela: false };
  } catch (err) {
    const codigo = codigoDoErro(err.message);

    if (FORA_DA_JANELA.includes(codigo)) {
      console.log(`Aviso não entregue a ${para}: janela de 24h fechada (${codigo})`);
      return { entregue: false, foraDaJanela: true };
    }

    console.error(`Falha ao notificar ${para}:`, err.message);
    return { entregue: false, foraDaJanela: false, erro: err.message };
  }
}

module.exports = { notificar, codigoDoErro, FORA_DA_JANELA };
