// Testa o transporte do bot com waClient e carClient dublados — nenhuma chamada
// real à Meta ou ao Estudo_Car.

const waPath  = require.resolve('./services/waClient.js');
// Guarda a função REAL de quebra antes de dublar o módulo, para o dublê exercitar
// a lógica de verdade em vez de fingir que ela existe.
const { partirTexto } = require('./services/waClient.js');
const carPath = require.resolve('./services/carClient.js');

const enviados = [];   // mensagens de texto que sairiam para o WhatsApp
const botoes   = [];   // mensagens interativas com botões
const listas   = [];   // mensagens interativas de lista
const audios   = [];   // mensagens de voz
const chamadas = [];   // payloads que iriam para o Estudo_Car
let typingDe   = [];   // ids marcados como "digitando"
let respostaDoCar = { reply: 'ok', transcricao: null, naoAutorizado: false };
let erroDoCar = null;

require.cache[waPath] = {
  id: waPath, filename: waPath, loaded: true,
  exports: {
    sendText: async (to, body) => {
      // Reproduz o sendText real: quebra no limite e manda parte por parte.
      // A API rejeita a mensagem INTEIRA acima de 4096 chars, então o dublê
      // estoura igual se alguma parte passar.
      for (const parte of partirTexto(body)) {
        if (parte.length > 4096) throw new Error('Param text.body must be at most 4096 characters long.');
        enviados.push({ to, body: parte });
      }
    },
    // Assinatura idêntica à real: (to, body, buttonText, rows, sectionTitle)
    sendList: async (to, body, buttonText, rows, secao) => {
      if (!Array.isArray(rows) || rows.length < 1 || rows.length > 10) return false;
      if (buttonText.length > 20) return false;                 // limites da API
      if (rows.some(r => r.title.length > 24)) return false;
      listas.push({ to, body, buttonText, rows, secao });
      return true;
    },
    sendButtons: async (to, body, bts) => {
      if (body.length > 1024) return false;          // mesmo limite da API real
      botoes.push({ to, body, bts });
      return true;
    },
    sendAudio: async (to, buffer) => {
      // A API só trata como mensagem de voz se for OGG/Opus.
      if (buffer.slice(0, 4).toString('ascii') !== 'OggS') throw new Error('audio nao e OGG');
      audios.push({ to, bytes: buffer.length });
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
  listas.length = 0;
  audios.length = 0;
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

  // 11. Escolha com 3 alternativas vira BOTÃO
  reset();
  respostaDoCar = { reply: 'É documento de qual tipo?', transcricao: null, naoAutorizado: false,
    opcoes: [{ id: 'crlv', titulo: 'CRLV' }, { id: 'crv', titulo: 'CRV' }, { id: 'atpv', titulo: 'ATPV' }] };
  await handleMessage({ from: USER, id: 'wA', type: 'text', text: { body: 'foto de documento' } });
  assert(botoes.length === 1 && listas.length === 0 && enviados.length === 0,
    '3 opções -> botões, sem texto');
  assert(ultimo(botoes).bts.map(b => b.id).join(',') === 'crlv,crv,atpv', 'ids das opções preservados');

  // 12. Escolha com 8 alternativas vira LISTA (botão só aceita 3)
  reset();
  respostaDoCar = { reply: 'Achei mais de um Palio. Qual deles?', transcricao: null, naoAutorizado: false,
    opcoes: Array.from({ length: 8 }, (_, i) => ({ id: `PLC${i}`, titulo: `Palio ${1996 + i}`, detalhe: 'Cor X' })) };
  await handleMessage({ from: USER, id: 'wB', type: 'text', text: { body: 'pintura no palio' } });
  assert(listas.length === 1 && botoes.length === 0, '8 opções -> lista');
  assert(ultimo(listas).rows.length === 8, 'as 8 opções entraram na lista');
  assert(ultimo(listas).rows.every(r => r.description), 'cada linha leva o detalhe');

  // 13. Mais de 10 não cabe em lista: cai para texto COM as opções escritas
  reset();
  respostaDoCar = { reply: 'Qual deles?', transcricao: null, naoAutorizado: false,
    opcoes: Array.from({ length: 14 }, (_, i) => ({ id: `P${i}`, titulo: `Carro ${i}` })) };
  await handleMessage({ from: USER, id: 'wC', type: 'text', text: { body: 'x' } });
  assert(listas.length === 1 && ultimo(listas).rows.length === 10, 'corta em 10, o teto da API');

  // 14. Clique numa linha da lista volta como texto
  reset();
  await handleMessage({
    from: USER, id: 'wD', type: 'interactive',
    interactive: { type: 'list_reply', list_reply: { id: 'KHV7A97', title: 'Palio EDX 1996' } }
  });
  assert(ultimo(chamadas).texto === 'KHV7A97', 'clique na lista -> repassa o id (a placa)');

  // 15. Sugestões saem DEPOIS da resposta, em mensagem própria
  reset();
  respostaDoCar = { reply: 'x'.repeat(2000), transcricao: null, naoAutorizado: false,
    sugestoes: [{ id: 'me mostra o balancete do polo', titulo: 'Ver balancete' },
                { id: 'quanto tem no caixa', titulo: 'Ver caixa' }] };
  await handleMessage({ from: USER, id: 'wE', type: 'text', text: { body: 'lança 100' } });
  assert(enviados.length >= 1, 'resposta longa sai como texto');
  assert(botoes.length === 1, 'sugestões vêm em mensagem interativa separada');
  assert(ultimo(botoes).body.length < 100, 'corpo da mensagem de sugestão é curto');
  assert(ultimo(botoes).bts[0].id === 'me mostra o balancete do polo',
    'o id do botão é o pedido inteiro, pronto para ser enviado');

  // 16. Resposta falada: o áudio da resposta REALMENTE sai
  reset();
  const ogg = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(500)]);
  respostaDoCar = { reply: null, transcricao: null, naoAutorizado: false,
    audioBase64: ogg.toString('base64') };
  await handleMessage({ from: USER, id: 'wF', type: 'text', text: { body: 'me responde em áudio: quantos carros' } });
  assert(audios.length === 1, 'resposta falada é enviada como voz', `enviou ${audios.length}`);
  assert(enviados.length === 0, 'sem texto duplicado quando a resposta é falada');
  assert(ultimo(audios).bytes === ogg.length, 'os bytes chegam inteiros');

  // 17. Resposta gigante é quebrada em partes, não estoura na API
  reset();
  const linhao = Array.from({ length: 400 }, (_, i) => `🚗 CARRO${i} — modelo ano cor`).join('\n');
  respostaDoCar = { reply: linhao, transcricao: null, naoAutorizado: false, aguardandoConfirmacao: false };
  await handleMessage({ from: USER, id: 'w12', type: 'text', text: { body: 'lista os carros' } });
  assert(enviados.length > 1, 'resposta longa -> quebrada em várias mensagens', `virou ${enviados.length}`);
  assert(enviados.every(e => e.body.length <= 4096), 'nenhuma parte passa de 4096 chars',
    `maior: ${Math.max(...enviados.map(e => e.body.length))}`);
  assert(enviados.every(e => !e.body.includes('CARRO0 ') || e.body.startsWith('🚗 CARRO0')),
    'corte respeita a quebra de linha');
  assert(enviados.map(e => e.body).join('\n').replace(/\s/g, '') === linhao.replace(/\s/g, ''),
    'nada é perdido no meio do caminho');

  // 12. Texto vazio é ignorado sem ruído
  reset();
  await handleMessage({ from: USER, id: 'w13', type: 'text', text: { body: '   ' } });
  assert(chamadas.length === 0 && enviados.length === 0, 'texto vazio -> ignorado');

  console.log(falhas ? `\n❌ ${falhas} TESTE(S) FALHARAM` : '\n✅ TODOS OS TESTES PASSARAM');
  process.exit(falhas ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
