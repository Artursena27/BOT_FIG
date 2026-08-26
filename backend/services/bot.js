const { sendText, sendButtons, showTyping, downloadMedia } = require('./waClient');
const { enviarMensagem } = require('./carClient');

const ERRO_GENERICO =
  '❌ Não consegui falar com o sistema agora. Tenta de novo em instantes.';

/**
 * Descobre o que veio na mensagem e devolve o que precisa ser baixado.
 * `null` = tipo que o suporte não trata (figurinha, contato, localização...).
 */
function interpretar(msg) {
  if (msg.type === 'text') {
    return { kind: 'texto', texto: msg.text?.body || '' };
  }

  // Clique num botão de confirmação: o id do botão vale como resposta escrita.
  if (msg.type === 'interactive') {
    const escolha = msg.interactive?.button_reply || msg.interactive?.list_reply;
    return { kind: 'texto', texto: escolha?.id || escolha?.title || '' };
  }

  if (msg.type === 'audio') {
    return { kind: 'audio', mediaId: msg.audio.id };
  }

  if (msg.type === 'image') {
    // A legenda costuma trazer o contexto ("nota do mecânico do Palio")
    return { kind: 'imagem', mediaId: msg.image.id, texto: msg.image.caption || '' };
  }

  if (msg.type === 'document') {
    const mime = msg.document?.mime_type || '';
    if (mime.startsWith('audio/')) return { kind: 'audio', mediaId: msg.document.id };
    if (mime.startsWith('image/')) {
      return { kind: 'imagem', mediaId: msg.document.id, texto: msg.document.caption || '' };
    }
  }

  return null;
}

/**
 * Monta o corpo que o Estudo_Car espera, baixando a mídia quando houver.
 */
async function montarPayload(from, entrada) {
  if (entrada.kind === 'texto') {
    return { from, texto: entrada.texto };
  }

  const { buffer, mime } = await downloadMedia(entrada.mediaId);
  const base64 = buffer.toString('base64');

  if (entrada.kind === 'audio') {
    return { from, audioBase64: base64, mimetype: mime };
  }

  return { from, imagemBase64: base64, mimetype: mime, texto: entrada.texto };
}

/**
 * Trata uma mensagem recebida pelo webhook da Cloud API.
 */
async function handleMessage(msg) {
  const from = msg.from;

  try {
    const entrada = interpretar(msg);

    if (!entrada) {
      await sendText(
        from,
        '🤔 Só entendo *texto*, *áudio* e *foto*. Manda de novo por um desses?'
      );
      return;
    }

    if (entrada.kind === 'texto' && !entrada.texto.trim()) return;

    // Mostra "digitando..." antes do trabalho pesado (transcrição + IA).
    await showTyping(msg.id);

    const payload = await montarPayload(from, entrada);
    const { reply, transcricao, naoAutorizado, aguardandoConfirmacao, avisos } = await enviarMensagem(payload);

    if (naoAutorizado) {
      console.warn(`Mensagem ignorada — número fora da allowlist: ${from}`);
      return;
    }

    // Avisos que ficaram na fila saem primeiro, cada um como mensagem própria:
    // misturar um resumo semanal dentro da resposta faria as duas coisas
    // parecerem uma só.
    for (const aviso of avisos || []) {
      await sendText(from, aviso);
    }

    if (!reply) return;

    // Ecoa o que foi ouvido: se a transcrição errou, o usuário vê na hora
    // em vez de descobrir depois que o lançamento entrou torto.
    const corpo = transcricao
      ? `🎤 _"${transcricao}"_\n\n${reply}`
      : reply;

    if (aguardandoConfirmacao) {
      const foi = await sendButtons(from, corpo, [
        { id: 'confirmar', title: '✅ Confirmo' },
        { id: 'cancelar',  title: '❌ Reprovo' }
      ]);

      // Corpo grande demais para mensagem interativa (vários lançamentos de uma
      // vez): manda como texto normal e explica como responder.
      if (!foi) {
        await sendText(from, `${corpo}\n\nResponda *sim* para gravar ou *não* para cancelar.`);
      }
      return;
    }

    await sendText(from, corpo);
  } catch (err) {
    console.error('Erro ao tratar mensagem:', err);
    try {
      await sendText(from, ERRO_GENERICO);
    } catch (e) {
      console.error('Falhou até a mensagem de erro:', e.message);
    }
  }
}

module.exports = { handleMessage, interpretar };
