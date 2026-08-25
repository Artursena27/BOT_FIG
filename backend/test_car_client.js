// Testa o cliente HTTP do Estudo_Car contra um servidor local que simula
// redeploy (503), queda de rede e erro de aplicação.
const http = require('http');

let comportamento = 'ok';
let recebidas = 0;

const srv = http.createServer((req, res) => {
  recebidas++;
  const responder = (code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  if (comportamento === 'ok') return responder(200, { reply: 'pronto' });
  if (comportamento === 'erro500') return responder(500, { erro: 'boom' });
  if (comportamento === 'naoAutorizado') return responder(403, { erro: 'Número não autorizado' });
  // 'subindo': primeiras 2 chamadas caem com 503, depois responde
  if (comportamento === 'subindo') {
    return recebidas <= 2 ? responder(503, {}) : responder(200, { reply: 'voltei' });
  }
  responder(200, {});
});

let falhas = 0;
function assert(cond, label, extra) {
  if (!cond) { console.error(`FAIL: ${label}${extra ? ' — ' + extra : ''}`); falhas++; }
  else console.log(`PASS: ${label}`);
}

srv.listen(0, '127.0.0.1', async () => {
  process.env.ESTUDO_CAR_URL = `http://127.0.0.1:${srv.address().port}`;
  process.env.INTERNAL_SECRET = 'seg';
  const { enviarMensagem } = require('./services/carClient');
  const payload = { from: '5581982267438', texto: 'oi' };

  try {
    // 1. Caminho feliz
    comportamento = 'ok'; recebidas = 0;
    let r = await enviarMensagem(payload);
    assert(r.reply === 'pronto' && recebidas === 1, 'sucesso na 1a tentativa, sem repetir');

    // 2. Redeploy em andamento: 503, 503, 200
    comportamento = 'subindo'; recebidas = 0;
    const t0 = Date.now();
    r = await enviarMensagem(payload);
    const levou = Date.now() - t0;
    assert(r.reply === 'voltei', 'sobrevive ao redeploy (503 -> 503 -> 200)');
    assert(recebidas === 3, 'tentou exatamente 3 vezes', `tentou ${recebidas}`);
    assert(levou >= 7000, 'respeitou o backoff de 2s + 5s', `levou ${levou}ms`);

    // 3. Erro 500 da aplicação NÃO pode ser repetido — repetir lançaria a
    //    mesma despesa duas vezes
    comportamento = 'erro500'; recebidas = 0;
    let erro = null;
    try { await enviarMensagem(payload); } catch (e) { erro = e; }
    assert(!!erro, '500 vira erro');
    assert(recebidas === 1, '500 NÃO é repetido', `bateu ${recebidas} vezes`);

    // 4. 403 também não é repetido, e vira naoAutorizado
    comportamento = 'naoAutorizado'; recebidas = 0;
    r = await enviarMensagem(payload);
    assert(r.naoAutorizado === true && recebidas === 1, '403 -> naoAutorizado, sem repetir');

    // 5. Servidor morto: repete e desiste com erro
    srv.close();
    await new Promise(r => setTimeout(r, 100));
    erro = null;
    const t1 = Date.now();
    try { await enviarMensagem(payload); } catch (e) { erro = e; }
    assert(!!erro, 'servidor fora do ar -> erro depois de tentar tudo');
    assert(Date.now() - t1 >= 17000, 'esgotou os 3 backoffs (2+5+10s)', `levou ${Date.now() - t1}ms`);
  } catch (e) {
    console.error('FATAL', e); falhas++;
  }

  try { srv.close(); } catch {}
  console.log(falhas ? `\n❌ ${falhas} TESTE(S) FALHARAM` : '\n✅ TODOS OS TESTES PASSARAM');
  process.exit(falhas ? 1 : 0);
});
