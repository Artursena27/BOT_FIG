import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { processarMensagem, interpretar, ehDono } from '../lib/bot.js';

const DONO = '5581982267438';

/** Dublês de tudo que o bot usa; `log` registra o que aconteceu, em ordem. */
function dubles({ processada = true, atrasados = [], resposta = { texto: 'ok', ferramentasUsadas: [] }, transcricao = 'oi' } = {}) {
  const log = [];
  const d = {
    log,
    wa: {
      showTyping: async () => log.push(['digitando']),
      sendText: async (para, t) => log.push(['texto', para, t]),
      sendSticker: async (para, webp) => log.push(['figurinha', para, webp.toString()]),
      downloadMedia: async (id) => ({ buffer: Buffer.from(`bytes-${id}`), mime: id.startsWith('vid') ? 'video/mp4' : 'image/jpeg' })
    },
    memoria: {
      registrarMensagem: async (papel, c) => log.push(['grava', papel, c]),
      historico: async () => [],
      listarMemorias: async () => []
    },
    lembretes: { pegarAtrasados: async () => atrasados },
    categoriasUsadas: async () => [],
    marcarProcessada: async () => processada,
    transcreverAudio: async () => transcricao,
    figurinhaDeImagem: async () => ({ webp: Buffer.from('webp-img') }),
    figurinhaDeVideo: async () => ({ webp: Buffer.from('webp-vid') }),
    rodarAgente: async (p) => { log.push(['agente', p.entrada]); return resposta; }
  };
  return d;
}

const msg = (extra) => ({ id: 'wamid.1', from: '558182267438', ...extra });

beforeEach(() => { process.env.DONO_WHATSAPP = DONO; });

test('ehDono compara com o nono dígito corrigido e aceita lista', () => {
  assert.equal(ehDono('558182267438', DONO), true);
  assert.equal(ehDono('5511999999999', DONO), false);
  assert.equal(ehDono('5511999999999', `${DONO}, 5511999999999`), true);
  assert.equal(ehDono('558182267438', ''), false);
});

test('interpretar cobre os tipos do WhatsApp', () => {
  assert.deepEqual(interpretar({ type: 'text', text: { body: 'oi' } }), { kind: 'texto', texto: 'oi' });
  assert.deepEqual(interpretar({ type: 'interactive', interactive: { button_reply: { id: 'sim', title: 'Sim' } } }),
    { kind: 'texto', texto: 'sim' });
  assert.deepEqual(interpretar({ type: 'button', button: { text: '✅ Visto' } }), { kind: 'texto', texto: '✅ Visto' });
  assert.equal(interpretar({ type: 'audio', audio: { id: 'a1' } }).kind, 'audio');
  assert.equal(interpretar({ type: 'document', document: { id: 'd', mime_type: 'image/gif' } }).kind, 'video');
  assert.equal(interpretar({ type: 'document', document: { id: 'd', mime_type: 'application/pdf' } }), null);
  assert.equal(interpretar({ type: 'sticker', sticker: { id: 's' } }).kind, 'ignorar');
  assert.equal(interpretar({ type: 'location' }), null);
});

test('mensagem de estranho é ignorada em silêncio', async () => {
  const d = dubles();
  await processarMensagem(msg({ from: '5511999999999', type: 'text', text: { body: 'oi' } }), d);
  assert.deepEqual(d.log, []);
});

test('reentrega da Meta não é processada de novo', async () => {
  const d = dubles({ processada: false });
  await processarMensagem(msg({ type: 'text', text: { body: 'oi' } }), d);
  assert.deepEqual(d.log, []);
});

test('texto vai para o agente, é respondido e gravado no histórico', async () => {
  const d = dubles({ resposta: { texto: 'Lembrete criado para qua às 09:00', ferramentasUsadas: ['criar_lembrete'] } });
  await processarMensagem(msg({ type: 'text', text: { body: 'me lembra quarta' } }), d);
  assert.deepEqual(d.log, [
    ['digitando'],
    ['agente', 'me lembra quarta'],
    ['grava', 'user', 'me lembra quarta'],
    ['grava', 'assistant', 'Lembrete criado para qua às 09:00'],
    ['texto', '558182267438', 'Lembrete criado para qua às 09:00']
  ]);
});

test('lembretes atrasados saem antes da resposta', async () => {
  const d = dubles({ atrasados: [{ id: 1, texto: 'Renovar o livro', quando: new Date('2026-11-05T12:00:00Z') }] });
  await processarMensagem(msg({ type: 'text', text: { body: 'oi' } }), d);
  const textos = d.log.filter(l => l[0] === 'texto').map(l => l[2]);
  assert.match(textos[0], /🔔 \*Lembrete\* \(era para .*05\/11 às 09:00\): Renovar o livro/);
  assert.equal(textos[1], 'ok');
});

test('foto sem legenda vira figurinha sem chamar o agente', async () => {
  const d = dubles();
  await processarMensagem(msg({ type: 'image', image: { id: 'img1' } }), d);
  assert.ok(d.log.some(l => l[0] === 'figurinha' && l[2] === 'webp-img'));
  assert.ok(!d.log.some(l => l[0] === 'agente'));
});

test('vídeo sem legenda vira figurinha animada', async () => {
  const d = dubles();
  await processarMensagem(msg({ type: 'video', video: { id: 'vid1' } }), d);
  assert.ok(d.log.some(l => l[0] === 'figurinha' && l[2] === 'webp-vid'));
});

test('foto com legenda vai ao agente como imagem, com o media_id', async () => {
  const d = dubles();
  await processarMensagem(msg({ type: 'image', image: { id: 'img2', caption: 'quanto deu essa nota?' } }), d);
  const [, entrada] = d.log.find(l => l[0] === 'agente');
  assert.match(entrada[0].text, /quanto deu essa nota\?\n\[imagem anexada, media_id=img2\]/);
  assert.match(entrada[1].image_url.url, /^data:image\/jpeg;base64,/);
  // No histórico fica só o texto, não a foto inteira.
  assert.ok(d.log.some(l => l[0] === 'grava' && l[1] === 'user' && !l[2].includes('base64')));
});

test('áudio é transcrito e a transcrição ecoa na resposta', async () => {
  const d = dubles({ transcricao: 'gastei 40 no mercado', resposta: { texto: 'Anotado!', ferramentasUsadas: [] } });
  await processarMensagem(msg({ type: 'audio', audio: { id: 'aud1' } }), d);
  assert.ok(d.log.some(l => l[0] === 'agente' && l[1] === 'gastei 40 no mercado'));
  assert.ok(d.log.some(l => l[0] === 'texto' && l[2] === '🎤 _"gastei 40 no mercado"_\n\nAnotado!'));
});

test('resposta vazia depois de mandar mídia não envia texto em branco', async () => {
  const d = dubles({ resposta: { texto: '', ferramentasUsadas: ['criar_figurinha'] } });
  await processarMensagem(msg({ type: 'text', text: { body: 'faz uma figurinha de gato' } }), d);
  assert.ok(!d.log.some(l => l[0] === 'texto'));
  assert.ok(d.log.some(l => l[0] === 'grava' && l[2] === '[usei: criar_figurinha]'));
});

test('erro inesperado vira mensagem de erro, não silêncio', async () => {
  const d = dubles();
  d.rodarAgente = async () => { throw new Error('OpenAI 429: quota'); };
  await processarMensagem(msg({ type: 'text', text: { body: 'oi' } }), d);
  assert.ok(d.log.some(l => l[0] === 'texto' && l[2] === '❌ Deu erro: OpenAI 429: quota'));
});
