/**
 * Cliente da WhatsApp Cloud API (Graph API da Meta).
 */

import crypto from 'node:crypto';

const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION || 'v21.0';
const BASE_URL = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

function token() {
  return process.env.WHATSAPP_TOKEN;
}

function phoneNumberId() {
  return process.env.PHONE_NUMBER_ID;
}

/**
 * Confere o HMAC que a Meta põe em cada webhook. Sem isso, qualquer um que
 * descubra a URL manda comandos para o agente em seu nome.
 *
 * @param {Buffer} corpoBruto  o corpo exatamente como chegou, antes do JSON.parse
 */
export function assinaturaValida(corpoBruto, assinatura, segredo) {
  if (!assinatura || !corpoBruto || !segredo) return false;
  const esperada = 'sha256=' +
    crypto.createHmac('sha256', segredo).update(corpoBruto).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(assinatura), Buffer.from(esperada));
  } catch {
    return false;
  }
}

/**
 * Brazilian "nono dígito" fix: WhatsApp webhooks report BR mobiles WITHOUT the
 * 9th digit (e.g. 558182267438), but the API expects it WITH the 9
 * (5581982267438). Insert it when missing so replies actually reach BR users.
 */
export function normalizeRecipient(to) {
  const n = String(to).replace(/\D/g, '');
  // 55 (country) + DDD (2) + subscriber (8) = 12 digits; mobile subscriber starts 6-9
  if (n.length === 12 && n.startsWith('55')) {
    const ddd = n.slice(2, 4);
    const subscriber = n.slice(4);
    if (/^[6-9]/.test(subscriber)) {
      return `55${ddd}9${subscriber}`;
    }
  }
  return n;
}

async function graphFetch(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token()}`,
      ...(options.headers || {})
    }
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Graph API ${res.status} on ${url}: ${body}`);
  }
  return res;
}

async function postMessage(payload) {
  await graphFetch(`${BASE_URL}/${phoneNumberId()}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', ...payload })
  });
}

// "Message failed to send because more than 24 hours have passed since the
// customer last replied" — e os primos dele. Fora da janela só template passa.
export const FORA_DA_JANELA = [131047, 131051, 470];

export function codigoDoErro(mensagem) {
  const m = String(mensagem).match(/"code"\s*:\s*(\d+)/);
  return m ? Number(m[1]) : null;
}

export function foraDaJanela(err) {
  return FORA_DA_JANELA.includes(codigoDoErro(err?.message));
}

// Teto de um texto na Cloud API. Passar disso não trunca: a API rejeita a
// mensagem inteira com erro 100.
const LIMITE_TEXTO = 4096;

/**
 * Quebra um texto em pedaços que cabem no limite, cortando em quebra de linha
 * quando dá, depois em espaço, e só no meio da palavra se não houver
 * alternativa.
 */
export function partirTexto(texto, limite = LIMITE_TEXTO) {
  const partes = [];
  let resto = String(texto ?? '');

  while (resto.length > limite) {
    const minimo = Math.floor(limite / 2);   // não aceita corte cedo demais
    let corte = resto.lastIndexOf('\n', limite);
    if (corte < minimo) corte = resto.lastIndexOf(' ', limite);
    if (corte < minimo) corte = limite;

    partes.push(resto.slice(0, corte).trimEnd());
    resto = resto.slice(corte).trimStart();
  }

  if (resto) partes.push(resto);
  return partes;
}

/**
 * Sends a plain text message, splitting it when it exceeds the API limit.
 */
export async function sendText(to, body) {
  const destino = normalizeRecipient(to);
  for (const parte of partirTexto(body)) {
    await postMessage({ to: destino, type: 'text', text: { body: parte } });
  }
}

// Limites da Cloud API para mensagem interativa.
const LIMITE_CORPO = 1024;
const LIMITE_TITULO = 20;

/**
 * Envia texto com botões de resposta rápida (máx. 3). O id do botão volta no
 * webhook como se o usuário tivesse digitado.
 *
 * Devolve false quando o corpo não cabe no limite da API — aí o chamador manda
 * como texto puro em vez de perder a mensagem.
 *
 * @param {Array<{id: string, title: string}>} buttons
 */
export async function sendButtons(to, body, buttons) {
  if (!body || body.length > LIMITE_CORPO) return false;

  await postMessage({
    to: normalizeRecipient(to),
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: body },
      action: {
        buttons: buttons.slice(0, 3).map(b => ({
          type: 'reply',
          reply: { id: b.id, title: b.title.slice(0, LIMITE_TITULO) }
        }))
      }
    }
  });

  return true;
}

/**
 * Mensagem de template aprovado. É o único jeito de falar com o usuário fora da
 * janela de 24h — o que acontece com todo lembrete marcado para dias depois.
 *
 * @param {string[]} parametros  valores de {{1}}, {{2}}... do corpo
 */
export async function sendTemplate(to, nome, idioma, parametros = []) {
  await postMessage({
    to: normalizeRecipient(to),
    type: 'template',
    template: {
      name: nome,
      language: { code: idioma },
      components: parametros.length
        ? [{ type: 'body', parameters: parametros.map(text => ({ type: 'text', text })) }]
        : []
    }
  });
}

/**
 * Marks the incoming message as read and shows the typing bubble.
 * Best-effort — never blocks the actual reply.
 */
export async function showTyping(messageId) {
  try {
    await postMessage({
      status: 'read',
      message_id: messageId,
      typing_indicator: { type: 'text' }
    });
  } catch (err) {
    console.warn('Typing indicator failed (ignored):', err.message);
  }
}

async function uploadMedia(buffer, mime, filename) {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mime);
  form.append('file', new Blob([buffer], { type: mime }), filename);

  const up = await graphFetch(`${BASE_URL}/${phoneNumberId()}/media`, { method: 'POST', body: form });
  const { id } = await up.json();
  if (!id) throw new Error(`Upload de ${mime} não retornou id`);
  return id;
}

/** Figurinha: WebP 512x512, até 100KB estática ou 500KB animada. */
export async function sendSticker(to, webp) {
  const id = await uploadMedia(webp, 'image/webp', 'figurinha.webp');
  await postMessage({ to: normalizeRecipient(to), type: 'sticker', sticker: { id } });
}

/**
 * Vídeo MP4. A Cloud API não tem tipo "GIF": GIF no WhatsApp é um MP4 curto e
 * mudo, e é assim que ele sai daqui.
 */
export async function sendVideo(to, mp4, caption) {
  const id = await uploadMedia(mp4, 'video/mp4', 'video.mp4');
  await postMessage({
    to: normalizeRecipient(to),
    type: 'video',
    video: { id, ...(caption ? { caption } : {}) }
  });
}

/**
 * Downloads received media (by media id). Returns { buffer, mime }.
 */
export async function downloadMedia(mediaId) {
  // 1. Resolve the short-lived media URL
  const metaRes = await graphFetch(`${BASE_URL}/${mediaId}`);
  const meta = await metaRes.json();

  // 2. Download the binary (also requires the Bearer token)
  const fileRes = await graphFetch(meta.url);
  const buffer = Buffer.from(await fileRes.arrayBuffer());

  return { buffer, mime: meta.mime_type };
}
