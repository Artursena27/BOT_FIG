const { sendText, sendButtons, sendList, showTyping, downloadMedia } = require('./waClient');
const { enviarMensagem } = require('./carClient');

/**
 * Mostra a escolha do jeito mais tocável que a API permitir.
 *
 * Até 3 alternativas cabem em botão, que é o formato mais rápido. De 4 a 10 vai
 * para lista. Passando disso, ou se o corpo não couber, volta para texto — mas
 * aí as opções precisam aparecer escritas, senão o usuário não sabe o que
 * responder.
 */
async function oferecerEscolha(from, corpo, opcoes) {
  const itens = opcoes.slice(0, 10);

  if (itens.length <= 3) {
    const ok = await sendButtons(from, corpo, itens.map(o => ({ id: o.id, title: o.titulo })));
    if (ok) return true;
  } else {
    const ok = await sendList(
      from, corpo, 'Escolher',
      itens.map(o => ({ id: o.id, title: o.titulo, description: o.detalhe })),
      'Opções'
    );
    if (ok) return true;
  }

  // Fallback: sem o menu, o texto tem que dizer quais são as alternativas.
  const escritas = itens.map((o, i) => `${i + 1}. ${o.titulo}${o.detalhe ? ` — ${o.detalhe}` : ''}`);
  await sendText(from, [corpo, '', ...escritas, '', 'Responda o número.'].join('\n'));
  return true;
}

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
    const { reply, transcricao, naoAutorizado, aguardandoConfirmacao, opcoes, sugestoes } =
      await enviarMensagem(payload);

    if (naoAutorizado) {
      console.warn(`Mensagem ignorada — número fora da allowlist: ${from}`);
      return;
    }

    if (!reply) return;

    // Ecoa o que foi ouvido: se a transcrição errou, o usuário vê na hora
    // em vez de descobrir depois que o lançamento entrou torto.
    const corpo = transcricao
      ? `🎤 _"${transcricao}"_\n\n${reply}`
      : reply;

    // Escolha entre alternativas conhecidas nunca deveria exigir digitação.
    if (opcoes && opcoes.length) {
      await oferecerEscolha(from, corpo, opcoes);
      return;
    }

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

    // Sugestões vão numa mensagem separada e curta, de propósito: a resposta
    // pode passar de 1024 chars (o teto da mensagem interativa), e enfiar os
    // atalhos dentro dela derrubaria os botões justamente nas respostas longas.
    if (sugestoes && sugestoes.length) {
      await oferecerEscolha(from, 'Quer ver mais alguma coisa?', sugestoes);
    }
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
