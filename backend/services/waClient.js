const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION || 'v21.0';
const BASE_URL = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

function token() {
  return process.env.WHATSAPP_TOKEN;
}

function phoneNumberId() {
  return process.env.PHONE_NUMBER_ID;
}

/**
 * Brazilian "nono dígito" fix: WhatsApp webhooks report BR mobiles WITHOUT the
 * 9th digit (e.g. 558182267438), but the API expects it WITH the 9
 * (5581982267438). Insert it when missing so replies actually reach BR users.
 */
function normalizeRecipient(to) {
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

// Teto de um texto na Cloud API. Passar disso não trunca: a API rejeita a
// mensagem inteira com erro 100.
const LIMITE_TEXTO = 4096;

/**
 * Quebra um texto em pedaços que cabem no limite, cortando em quebra de linha
 * quando dá (listas de carros já vêm uma por linha), depois em espaço, e só
 * no meio da palavra se não houver alternativa.
 */
function partirTexto(texto, limite = LIMITE_TEXTO) {
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
async function sendText(to, body) {
  const destino = normalizeRecipient(to);
  for (const parte of partirTexto(body)) {
    await postMessage({ to: destino, type: 'text', text: { body: parte } });
  }
}

// Limites da Cloud API para mensagem interativa.
const LIMITE_CORPO = 1024;
const LIMITE_TITULO = 20;

/**
 * Envia texto com botões de resposta rápida (máx. 3).
 *
 * Devolve false quando o corpo não cabe no limite da API — aí o chamador manda
 * como texto puro em vez de perder a mensagem.
 *
 * @param {Array<{id: string, title: string}>} buttons
 */
async function sendButtons(to, body, buttons) {
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
 * Marks the incoming message as read and shows the typing bubble.
 *
 * Transcribing plus reasoning takes several seconds; without this the user
 * stares at silence and re-sends. Best-effort — never blocks the actual reply.
 */
async function showTyping(messageId) {
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

/**
 * Downloads received media (by media id). Returns { buffer, mime }.
 */
async function downloadMedia(mediaId) {
  // 1. Resolve the short-lived media URL
  const metaRes = await graphFetch(`${BASE_URL}/${mediaId}`);
  const meta = await metaRes.json();

  // 2. Download the binary (also requires the Bearer token)
  const fileRes = await graphFetch(meta.url);
  const buffer = Buffer.from(await fileRes.arrayBuffer());

  return { buffer, mime: meta.mime_type };
}

module.exports = {
  sendText,
  partirTexto,
  sendButtons,
  showTyping,
  downloadMedia,
  normalizeRecipient
};
