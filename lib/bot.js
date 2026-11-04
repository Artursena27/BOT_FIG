/**
 * Trata uma mensagem recebida pelo webhook: filtra, prepara a entrada (baixa
 * mídia, transcreve áudio), roda o agente e responde.
 */

import * as wa from './whatsapp.js';
import * as memoria from './memoria.js';
import * as lembretes from './lembretes.js';
import { categoriasUsadas } from './financas.js';
import { rodarAgente } from './agente.js';
import { transcreverAudio } from './transcricao.js';
import { figurinhaDeImagem, figurinhaDeVideo } from './midia.js';
import { formatarDataHora } from './tempo.js';
import { db } from './db.js';

/** Grava o id da mensagem; false se já tinha sido processada (reentrega da Meta). */
export async function marcarProcessada(wamid) {
  const linhas = await db()`
    insert into agente.processadas (wamid) values (${wamid})
    on conflict do nothing returning wamid
  `;
  return linhas.length > 0;
}

const PADRAO = {
  wa, memoria, lembretes, categoriasUsadas, rodarAgente, transcreverAudio,
  figurinhaDeImagem, figurinhaDeVideo, marcarProcessada
};

/**
 * Só o dono conversa com o agente. Aceita mais de um número separado por
 * vírgula, para o caso de você querer liberar alguém de casa.
 */
export function ehDono(numero, donos = process.env.DONO_WHATSAPP) {
  if (!donos) return false;
  const alvo = wa.normalizeRecipient(numero);
  return donos.split(',').some(d => wa.normalizeRecipient(d.trim()) === alvo);
}

/**
 * O que veio na mensagem. `null` = tipo que o agente não trata;
 * kind 'ignorar' = não responde nada.
 */
export function interpretar(msg) {
  switch (msg.type) {
    case 'text':
      return { kind: 'texto', texto: msg.text?.body || '' };

    // Clique num botão ou lista: vale como resposta escrita.
    case 'interactive': {
      const escolha = msg.interactive?.button_reply || msg.interactive?.list_reply;
      return { kind: 'texto', texto: escolha?.id || escolha?.title || '' };
    }
    case 'button':
      return { kind: 'texto', texto: msg.button?.text || msg.button?.payload || '' };

    case 'audio':
      return { kind: 'audio', mediaId: msg.audio.id };
    case 'image':
      return { kind: 'imagem', mediaId: msg.image.id, legenda: msg.image.caption || '' };
    case 'video':
      return { kind: 'video', mediaId: msg.video.id, legenda: msg.video.caption || '' };

    // Figurinha recebida não pede resposta; responder seria só ruído.
    case 'sticker':
    case 'reaction':
      return { kind: 'ignorar' };

    case 'document': {
      const mime = msg.document?.mime_type || '';
      const base = { mediaId: msg.document.id, legenda: msg.document.caption || '' };
      if (mime.startsWith('audio/')) return { kind: 'audio', mediaId: msg.document.id };
      if (mime === 'image/gif' || mime.startsWith('video/')) return { kind: 'video', ...base };
      if (mime.startsWith('image/')) return { kind: 'imagem', ...base };
      return null;
    }

    default:
      return null;
  }
}

/**
 * Converte a entrada no que o modelo recebe e no que fica gravado no
 * histórico. Imagem com legenda vai como imagem de verdade (o modelo enxerga);
 * no histórico fica só o texto, para não reenviar a foto a cada mensagem.
 */
async function montarEntrada(e, d) {
  if (e.kind === 'texto') return { entrada: e.texto, registro: e.texto };

  if (e.kind === 'imagem') {
    const texto = `${e.legenda}\n[imagem anexada, media_id=${e.mediaId}]`;
    const { buffer, mime } = await d.wa.downloadMedia(e.mediaId);
    return {
      entrada: [
        { type: 'text', text: texto },
        { type: 'image_url', image_url: { url: `data:${mime};base64,${buffer.toString('base64')}` } }
      ],
      registro: texto
    };
  }

  // vídeo com legenda
  const texto = `${e.legenda}\n[vídeo anexado, media_id=${e.mediaId}]`;
  return { entrada: texto, registro: texto };
}

const resumoDoErro = err => String(err?.message || err).slice(0, 300);

export async function processarMensagem(msg, d = PADRAO) {
  const de = msg.from;

  if (!ehDono(de)) {
    // Silêncio: responder confirmaria a um estranho que este número é um bot.
    console.warn(`Mensagem ignorada — não é do dono: ${de}`);
    return;
  }

  if (!(await d.marcarProcessada(msg.id))) return;

  try {
    await d.wa.showTyping(msg.id);

    // A janela de 24h acabou de reabrir: hora de entregar o que a Meta barrou.
    const atrasados = await d.lembretes.pegarAtrasados();
    if (atrasados.length) {
      await d.wa.sendText(de, atrasados
        .map(l => `🔔 *Lembrete* (era para ${formatarDataHora(l.quando)}): ${l.texto}`)
        .join('\n'));
    }

    const e = interpretar(msg);
    if (!e) {
      await d.wa.sendText(de, '🤔 Ainda não sei lidar com esse tipo de mensagem.');
      return;
    }
    if (e.kind === 'ignorar') return;
    if (e.kind === 'texto' && !e.texto.trim()) return;

    // Foto ou vídeo sem legenda: figurinha na hora, sem gastar o modelo.
    if ((e.kind === 'imagem' || e.kind === 'video') && !e.legenda.trim()) {
      const { buffer, mime } = await d.wa.downloadMedia(e.mediaId);
      const { webp } = e.kind === 'video' || mime === 'image/gif'
        ? await d.figurinhaDeVideo(buffer)
        : await d.figurinhaDeImagem(buffer);
      await d.wa.sendSticker(de, webp);
      await d.memoria.registrarMensagem('user', `[${e.kind} sem legenda, media_id=${e.mediaId}]`);
      await d.memoria.registrarMensagem('assistant', '[figurinha enviada]');
      return;
    }

    let transcricao = null;
    if (e.kind === 'audio') {
      const { buffer } = await d.wa.downloadMedia(e.mediaId);
      transcricao = await d.transcreverAudio(buffer);
      if (!transcricao) {
        await d.wa.sendText(de, '🎤 Não consegui entender o áudio. Manda de novo?');
        return;
      }
      e.kind = 'texto';
      e.texto = transcricao;
    }

    const { entrada, registro } = await montarEntrada(e, d);
    const [historico, memorias, categorias] = await Promise.all([
      d.memoria.historico(), d.memoria.listarMemorias(), d.categoriasUsadas()
    ]);

    const { texto, ferramentasUsadas } = await d.rodarAgente({
      historico, entrada, memorias, categorias, ctx: { para: de, wa: d.wa }
    });

    await d.memoria.registrarMensagem('user', registro);
    await d.memoria.registrarMensagem(
      'assistant',
      texto || (ferramentasUsadas.length ? `[usei: ${ferramentasUsadas.join(', ')}]` : '')
    );

    // Ecoa o que foi ouvido: se a transcrição errou, dá para ver na hora.
    const corpo = transcricao && texto ? `🎤 _"${transcricao}"_\n\n${texto}` : texto;
    if (corpo) await d.wa.sendText(de, corpo);
  } catch (err) {
    console.error('Erro ao tratar mensagem:', err);
    try {
      await d.wa.sendText(de, `❌ Deu erro: ${resumoDoErro(err)}`);
    } catch (e2) {
      console.error('Falhou até a mensagem de erro:', e2.message);
    }
  }
}
