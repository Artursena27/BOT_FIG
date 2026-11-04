/**
 * Webhook da WhatsApp Cloud API.
 *
 * GET  — handshake que a Meta faz uma vez, ao cadastrar a URL.
 * POST — cada mensagem recebida. Responde 200 na hora (a Meta reenvia se
 *        demorar) e continua o trabalho depois, via waitUntil.
 */

import { waitUntil } from '@vercel/functions';
import { assinaturaValida } from '../lib/whatsapp.js';
import { processarMensagem } from '../lib/bot.js';

export function GET(request) {
  const q = new URL(request.url).searchParams;
  if (q.get('hub.mode') === 'subscribe' && q.get('hub.verify_token') === process.env.VERIFY_TOKEN) {
    return new Response(q.get('hub.challenge'), { status: 200 });
  }
  return new Response('forbidden', { status: 403 });
}

/** Extrai as mensagens do envelope do webhook (ignora recibos de entrega). */
export function mensagensDoWebhook(corpo) {
  const msgs = [];
  for (const entry of corpo?.entry || []) {
    for (const change of entry.changes || []) {
      msgs.push(...(change.value?.messages || []));
    }
  }
  return msgs;
}

export async function POST(request) {
  if (!process.env.APP_SECRET) {
    console.error('APP_SECRET ausente — webhook recusado. Configure a variável na Vercel.');
    return new Response('APP_SECRET não configurado', { status: 503 });
  }

  // A assinatura é sobre os bytes exatos; por isso lê o corpo cru antes do parse.
  const bruto = Buffer.from(await request.arrayBuffer());
  if (!assinaturaValida(bruto, request.headers.get('x-hub-signature-256'), process.env.APP_SECRET)) {
    console.warn('Assinatura inválida — webhook descartado.');
    return new Response('forbidden', { status: 403 });
  }

  let corpo;
  try {
    corpo = JSON.parse(bruto.toString('utf8'));
  } catch {
    return new Response('bad request', { status: 400 });
  }

  // Em sequência, para "me lembra disso" + "e daquilo" não chegarem fora de ordem.
  const msgs = mensagensDoWebhook(corpo);
  waitUntil((async () => {
    for (const msg of msgs) {
      await processarMensagem(msg).catch(err => console.error('Erro não tratado:', err));
    }
  })());

  return new Response('ok', { status: 200 });
}
