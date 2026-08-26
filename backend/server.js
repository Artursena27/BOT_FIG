const express = require('express');
const crypto = require('crypto');
const { handleMessage } = require('./services/bot');
const { notificar } = require('./services/notificador');

const app = express();
const PORT = process.env.PORT || 3001;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const APP_SECRET = process.env.APP_SECRET;

// Keep the raw body so we can validate Meta's webhook signature
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

// Aviso partindo do sistema (resumo semanal, venda registrada...). Chamado pelo
// Estudo_Car, nunca pela internet aberta.
app.post('/notificar', async (req, res) => {
  if (!process.env.INTERNAL_SECRET) {
    return res.status(503).json({ erro: 'INTERNAL_SECRET não configurado' });
  }
  if (req.headers['x-internal-secret'] !== process.env.INTERNAL_SECRET) {
    return res.sendStatus(401);
  }

  const { para, texto } = req.body || {};
  if (!para || !texto) return res.status(400).json({ erro: 'para e texto são obrigatórios' });

  const r = await notificar(para, texto);
  return res.json(r);
});

// Healthcheck (Railway)
app.get('/health', (req, res) => res.sendStatus(200));

// Webhook verification (Meta calls this once when you register the webhook URL)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verified.');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

function isValidSignature(req) {
  const signature = req.headers['x-hub-signature-256'];
  if (!signature || !req.rawBody) return false;
  const expected = 'sha256=' +
    crypto.createHmac('sha256', APP_SECRET).update(req.rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

// Webhook receiver
app.post('/webhook', (req, res) => {
  // Sem APP_SECRET qualquer um que descubra esta URL lança despesa no
  // financeiro. Enquanto isso aqui só fazia figurinha dava para relevar; agora
  // não. Recusa tudo, alto e claro, em vez de aceitar cegamente.
  if (!APP_SECRET) {
    console.error('APP_SECRET ausente — webhook recusado. Configure a variável no Railway.');
    return res.sendStatus(503);
  }

  if (!isValidSignature(req)) {
    console.warn('Assinatura inválida — webhook descartado.');
    return res.sendStatus(403);
  }

  // ACK immediately — Meta retries if we don't answer 200 fast
  res.sendStatus(200);

  // Then process asynchronously (fire-and-forget)
  const entries = req.body?.entry || [];
  for (const entry of entries) {
    for (const change of entry.changes || []) {
      const messages = change.value?.messages || [];
      for (const msg of messages) {
        handleMessage(msg).catch((err) =>
          console.error('Unhandled bot error:', err)
        );
      }
      // change.value.statuses (delivery receipts) are intentionally ignored
    }
  }
});

app.listen(PORT, () => {
  console.log(`Suporte Estudo_Car — webhook ouvindo na porta ${PORT}`);
  for (const v of ['WHATSAPP_TOKEN', 'PHONE_NUMBER_ID', 'VERIFY_TOKEN', 'APP_SECRET', 'ESTUDO_CAR_URL', 'INTERNAL_SECRET']) {
    if (!process.env[v]) console.warn(`  ⚠️  ${v} não configurada`);
  }
});
