# 🚗 Suporte Estudo_Car no WhatsApp

Bot de WhatsApp que recebe **áudio, texto ou foto** e transforma em lançamento no
sistema **Estudo_Car** — despesa, venda, compra, cadastro de carro.

> Você manda: *"pintura do palio 92 azul, 500 reais em fofinho"*
> Ele responde: **Adicionar despesa "Pintura" de R$ 500,00 ao carro ABC1234 — Fofinho**
> com os botões **✅ Confirmo** / **❌ Reprovo**. Clicou em confirmar, gravou.

## Arquitetura

Este projeto é **só transporte**. Ele não conhece carro, despesa nem banco de dados.

```
WhatsApp ──webhook──> WEB_FIG (aqui)              Estudo_Car
                      · valida a assinatura        · POST /api/wpp/mensagem
                      · baixa a mídia      ─────>    · transcreve o áudio
                      · manda pro Car               · extrai e classifica
                      · devolve a resposta <─────   · confirma e grava no Supabase
```

Toda a regra de negócio vive no Estudo_Car, reaproveitando o mesmo `services/iaChat.js`
que serve o chat do site. Uma fonte de verdade só — o que muda lá, muda aqui.

## Fluxo

1. Chega mensagem (áudio, texto, foto ou clique de botão).
2. O bot marca como lida e mostra "digitando".
3. Áudio e foto são baixados da Meta e enviados em base64 ao Estudo_Car.
4. O Estudo_Car transcreve, entende, e devolve uma confirmação pronta.
5. O bot mostra a confirmação com botões. Confirmado → grava.

Áudio tem a transcrição ecoada na resposta (`🎤 "..."`), para você ver na hora se
ele ouviu errado, em vez de descobrir depois com o lançamento torto.

## Variáveis de ambiente

| Variável | Obrigatória | Descrição |
|---|---|---|
| `WHATSAPP_TOKEN` | ✅ | Access token da Cloud API |
| `PHONE_NUMBER_ID` | ✅ | ID do número no painel da Meta |
| `VERIFY_TOKEN` | ✅ | String qualquer, igual à cadastrada no webhook |
| `APP_SECRET` | ✅ | App Secret da Meta — **sem ele o webhook recusa tudo** |
| `ESTUDO_CAR_URL` | ✅ | `https://estudocar-production.up.railway.app` |
| `INTERNAL_SECRET` | ✅ | O mesmo valor configurado no Estudo_Car |
| `GRAPH_API_VERSION` | não | Default `v21.0` |
| `CAR_TIMEOUT_MS` | não | Default 60000 |
| `PORT` | não | O Railway injeta |

**A allowlist de números não fica aqui** — fica no Estudo_Car (`WHATSAPP_AUTORIZADOS`),
para não haver duas listas divergindo. Mensagem de número não autorizado é ignorada
em silêncio: responder confirmaria a um estranho que este número existe.

### Sobre o `APP_SECRET`

Não é opcional. Sem ele, qualquer um que descubra a URL do webhook consegue forjar
uma mensagem e lançar despesa no financeiro. O servidor recusa (`503`) e grita no log
enquanto a variável não estiver configurada.

## Rodar local

```bash
npm install
npm test          # testes do transporte, sem tocar na Meta nem no Estudo_Car
npm start
```

Para receber webhooks de verdade, exponha com um túnel (cloudflared/ngrok) e cadastre
a URL em **WhatsApp → Configuration → Webhook** no painel da Meta.

## Deploy

Railway, projeto `web_sities`, ambiente `FIG`, serviço `WEB_FIG`.
`npm start` sobe o webhook; `/health` responde ao healthcheck.

## Limitações conhecidas

- O número é de **teste** da Meta: só entrega para destinatários cadastrados na
  allowlist do painel (máximo 5). Para atender qualquer pessoa, é preciso um número
  dedicado com verificação de negócio.
- Confirmação com mais de ~1000 caracteres (muitos lançamentos de uma vez) não cabe
  na mensagem interativa; nesse caso vai como texto e o usuário responde *sim*/*não*.
