// Testa o transporte do bot com waClient e carClient dublados — nenhuma chamada
// real à Meta ou ao Estudo_Car.

const waPath  = require.resolve('./services/waClient.js');
const carPath = require.resolve('./services/carClient.js');

const enviados = [];   // mensagens de texto que sairiam para o WhatsApp
const botoes   = [];   // mensagens interativas com botões
const chamadas = [];   // payloads que iriam para o Estudo_Car
let typingDe   = [];   // ids marcados como "digitando"
let respostaDoCar = { reply: 'ok', transcricao: null, naoAutorizado: false };
let erroDoCar = null;

require.cache[waPath] = {
  id: waPath, filename: waPath, loaded: true,
  exports: {
    sendText: async (to, body) => { enviados.push({ to, body }); },
    sendButtons: async (to, body, bts) => {
      if (body.length > 1024) return false;          // mesmo limite da API real
      botoes.push({ to, body, bts });
      return true;
    },
    showTyping: async (id) => { typingDe.push(id); },
    downloadMedia: async (mediaId) => ({
      buffer: Buffer.from(`bytes-de-${mediaId}`),
      mime: mediaId.startsWith('aud') ? 'audio/ogg; codecs=opus' : 'image/jpeg'
    })
  }
};

require.cache[carPath] = {
  id: carPath, filename: carPath, loaded: true,
  exports: {
    enviarMensagem: async (payload) => {
      chamadas.push(payload);
      if (erroDoCar) throw erroDoCar;
      return respostaDoCar;
    }
  }
};

const { handleMessage } = require('./services/bot');

function reset() {
  enviados.length = 0;
  botoes.length = 0;
  chamadas.length = 0;
  typingDe = [];
  respostaDoCar = { reply: 'ok', transcricao: null, naoAutorizado: false };
  erroDoCar = null;
}

const ultimo = arr => arr[arr.length - 1];
let falhas = 0;
function assert(cond, label) {
  if (!cond) { console.error(`FAIL: ${label}`); falhas++; }
  else console.log(`PASS: ${label}`);
}

const USER = '5581982267438';

(async () => {
  // 1. Texto simples é repassado como texto
  reset();
  await handleMessage({ from: USER, id: 'w1', type: 'text', text: { body: 'lança 500 de pintura no ABC1234' } });
  assert(chamadas.length === 1 && ultimo(chamadas).texto === 'lança 500 de pintura no ABC1234',
    'texto -> repassado como texto');
  assert(ultimo(enviados).body === 'ok', 'texto -> responde o que o Car devolveu');
  assert(typingDe.includes('w1'), 'texto -> mostra "digitando"');

  // 2. Áudio vira audioBase64 com o mime correto
  reset();
  respostaDoCar = { reply: '📝 Confere pra mim', transcricao: 'pintura do palio 500 reais', naoAutorizado: false };
  await handleMessage({ from: USER, id: 'w2', type: 'audio', audio: { id: 'aud1' } });
  const cAudio = ultimo(chamadas);
  assert(cAudio.audioBase64 === Buffer.from('bytes-de-aud1').toString('base64'),
    'áudio -> baixa e manda em base64');
  assert(cAudio.mimetype === 'audio/ogg; codecs=opus', 'áudio -> preserva o mimetype do WhatsApp');
  assert(ultimo(enviados).body.includes('pintura do palio 500 reais') && ultimo(enviados).body.includes('📝'),
    'áudio -> ecoa a transcrição junto da resposta');

  // 3. Imagem com legenda leva as duas coisas
  reset();
  await handleMessage({ from: USER, id: 'w3', type: 'image', image: { id: 'img1', caption: 'nota do mecânico' } });
  const cImg = ultimo(chamadas);
  assert(cImg.imagemBase64 && cImg.texto === 'nota do mecânico' && cImg.mimetype === 'image/jpeg',
    'imagem -> manda base64 + legenda');

  // 4. Documento com mime de áudio é tratado como áudio
  reset();
  await handleMessage({ from: USER, id: 'w4', type: 'document', document: { id: 'aud2', mime_type: 'audio/mpeg' } });
  assert(ultimo(chamadas).audioBase64 && !ultimo(chamadas).imagemBase64,
    'documento de áudio -> tratado como áudio');

  // 5. Tipo não suportado avisa e não chama o Car
  reset();
  await handleMessage({ from: USER, id: 'w5', type: 'sticker', sticker: { id: 's1' } });
  assert(chamadas.length === 0, 'figurinha -> não chama o Estudo_Car');
  assert(ultimo(enviados).body.includes('texto'), 'figurinha -> avisa o que aceita');

  // 6. Número fora da allowlist: silêncio total
  reset();
  respostaDoCar = { reply: null, transcricao: null, naoAutorizado: true };
  await handleMessage({ from: '5511000000000', id: 'w6', type: 'text', text: { body: 'oi' } });
  assert(enviados.length === 0, 'não autorizado -> não responde nada');

  // 7. Estudo_Car fora do ar -> mensagem de erro amigável
  reset();
  erroDoCar = new Error('Estudo_Car 500: boom');
  await handleMessage({ from: USER, id: 'w7', type: 'text', text: { body: 'oi' } });
  assert(ultimo(enviados).body.includes('❌'), 'erro no Car -> avisa o usuário');

  // 8. Confirmação vira botões, não texto
  reset();
  respostaDoCar = { reply: 'Adicionar despesa de R$ 500', transcricao: null, naoAutorizado: false, aguardandoConfirmacao: true };
  await handleMessage({ from: USER, id: 'w8', type: 'text', text: { body: 'lança 500' } });
  assert(botoes.length === 1 && enviados.length === 0, 'confirmação -> manda botões, não texto');
  assert(ultimo(botoes).bts.map(b => b.id).join(',') === 'confirmar,cancelar',
    'botões com os ids confirmar/cancelar');
  assert(ultimo(botoes).bts.every(b => b.title.length <= 20), 'títulos cabem no limite de 20 chars');

  // 9. Clique no botão volta como texto
  reset();
  await handleMessage({
    from: USER, id: 'w9', type: 'interactive',
    interactive: { type: 'button_reply', button_reply: { id: 'confirmar', title: '✅ Confirmo' } }
  });
  assert(ultimo(chamadas).texto === 'confirmar', 'clique no botão -> repassa o id como texto');

  // 10. Confirmação longa demais cai para texto com instrução
  reset();
  respostaDoCar = { reply: 'x'.repeat(1100), transcricao: null, naoAutorizado: false, aguardandoConfirmacao: true };
  await handleMessage({ from: USER, id: 'w10', type: 'text', text: { body: 'muitos lançamentos' } });
  assert(botoes.length === 0 && enviados.length === 1, 'corpo longo -> não usa botões');
  assert(ultimo(enviados).body.includes('*sim*'), 'fallback explica como responder por texto');

  // 11. Texto vazio é ignorado sem ruído
  reset();
  await handleMessage({ from: USER, id: 'w11', type: 'text', text: { body: '   ' } });
  assert(chamadas.length === 0 && enviados.length === 0, 'texto vazio -> ignorado');

  console.log(falhas ? `\n❌ ${falhas} TESTE(S) FALHARAM` : '\n✅ TODOS OS TESTES PASSARAM');
  process.exit(falhas ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
