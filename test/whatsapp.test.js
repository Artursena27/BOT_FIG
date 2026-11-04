import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  assinaturaValida, normalizeRecipient, partirTexto, foraDaJanela, codigoDoErro
} from '../lib/whatsapp.js';
import { GET, POST, mensagensDoWebhook } from '../api/webhook.js';

const assinar = (corpo, segredo) =>
  'sha256=' + crypto.createHmac('sha256', segredo).update(corpo).digest('hex');

test('assinatura do webhook', () => {
  const corpo = Buffer.from('{"a":1}');
  assert.equal(assinaturaValida(corpo, assinar(corpo, 's3gr3do'), 's3gr3do'), true);
  assert.equal(assinaturaValida(corpo, assinar(corpo, 'outro'), 's3gr3do'), false);
  assert.equal(assinaturaValida(corpo, 'sha256=curta', 's3gr3do'), false);
  assert.equal(assinaturaValida(corpo, undefined, 's3gr3do'), false);
});

test('nono dígito brasileiro', () => {
  assert.equal(normalizeRecipient('558182267438'), '5581982267438');
  assert.equal(normalizeRecipient('5581982267438'), '5581982267438');
  assert.equal(normalizeRecipient('+55 (81) 3222-1234'), '558132221234'); // fixo não ganha 9
});

test('partirTexto respeita o limite e prefere quebra de linha', () => {
  const linhas = Array.from({ length: 300 }, (_, i) => `linha ${i} ${'x'.repeat(20)}`).join('\n');
  const partes = partirTexto(linhas, 4096);
  assert.ok(partes.length > 1);
  assert.ok(partes.every(p => p.length <= 4096));
  assert.ok(partes.every(p => p.startsWith('linha')));
  assert.equal(partes.join('\n'), linhas);
});

test('reconhece erro de janela de 24h', () => {
  const err = new Error('Graph API 400 on x: {"error":{"code":131047,"message":"Re-engagement"}}');
  assert.equal(codigoDoErro(err.message), 131047);
  assert.equal(foraDaJanela(err), true);
  assert.equal(foraDaJanela(new Error('Graph API 500: {"error":{"code":1}}')), false);
});

test('GET do webhook faz o handshake só com o token certo', async () => {
  process.env.VERIFY_TOKEN = 'tok';
  const ok = GET(new Request('https://x/api/webhook?hub.mode=subscribe&hub.verify_token=tok&hub.challenge=123'));
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), '123');
  const nao = GET(new Request('https://x/api/webhook?hub.mode=subscribe&hub.verify_token=errado&hub.challenge=1'));
  assert.equal(nao.status, 403);
});

test('POST do webhook recusa sem APP_SECRET e com assinatura errada', async () => {
  const corpo = JSON.stringify({ entry: [] });

  delete process.env.APP_SECRET;
  let r = await POST(new Request('https://x/api/webhook', { method: 'POST', body: corpo }));
  assert.equal(r.status, 503);

  process.env.APP_SECRET = 'app';
  r = await POST(new Request('https://x/api/webhook', {
    method: 'POST', body: corpo, headers: { 'x-hub-signature-256': assinar(corpo, 'outro') }
  }));
  assert.equal(r.status, 403);
});

test('mensagensDoWebhook ignora recibos de entrega', () => {
  const corpo = {
    entry: [{ changes: [
      { value: { messages: [{ id: 'a' }, { id: 'b' }] } },
      { value: { statuses: [{ id: 'recibo' }] } }
    ] }]
  };
  assert.deepEqual(mensagensDoWebhook(corpo).map(m => m.id), ['a', 'b']);
  assert.deepEqual(mensagensDoWebhook({}), []);
});
