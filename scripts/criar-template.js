/**
 * Cria na Meta o template usado para lembretes fora da janela de 24h.
 *
 *   npm run template
 *
 * Lê WHATSAPP_TOKEN do .env. Descobre sozinho a conta do WhatsApp Business
 * (WABA) à qual o token dá acesso. Se o template já existir, só mostra o status.
 */

const VERSAO = process.env.GRAPH_API_VERSION || 'v21.0';
const NOME = process.env.LEMBRETE_TEMPLATE || 'lembrete';
const IDIOMA = process.env.LEMBRETE_TEMPLATE_IDIOMA || 'pt_BR';
const TOKEN = process.env.WHATSAPP_TOKEN;

if (!TOKEN) {
  console.error('Falta WHATSAPP_TOKEN no .env');
  process.exit(1);
}

async function graph(caminho, opcoes = {}) {
  const res = await fetch(`https://graph.facebook.com/${VERSAO}/${caminho}`, {
    ...opcoes,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...opcoes.headers }
  });
  const corpo = await res.json();
  if (!res.ok) throw new Error(`${res.status}: ${JSON.stringify(corpo.error || corpo)}`);
  return corpo;
}

async function descobrirWaba() {
  if (process.env.WABA_ID) return process.env.WABA_ID;
  const { data } = await graph(`debug_token?input_token=${TOKEN}`);
  const escopo = (data.granular_scopes || [])
    .find(s => s.scope === 'whatsapp_business_management');
  const id = escopo?.target_ids?.[0];
  if (!id) throw new Error('não achei a WABA pelo token; defina WABA_ID no .env');
  return id;
}

const waba = await descobrirWaba();
console.log(`WABA: ${waba}`);

const { data: existentes } = await graph(`${waba}/message_templates?name=${NOME}&fields=name,status,language`);
const igual = existentes.find(t => t.name === NOME && t.language === IDIOMA);
if (igual) {
  console.log(`Template "${NOME}" (${IDIOMA}) já existe — status: ${igual.status}`);
  process.exit(0);
}

// A Meta recusa variável no começo ou no fim do corpo, por isso o texto em volta.
// O botão reabre a janela de 24h com um toque.
const criado = await graph(`${waba}/message_templates`, {
  method: 'POST',
  body: JSON.stringify({
    name: NOME,
    language: IDIOMA,
    category: 'UTILITY',
    components: [
      {
        type: 'BODY',
        text: '🔔 Lembrete: {{1}}\n\nResponda esta mensagem para falar comigo.',
        example: { body_text: [['Renovar o livro na biblioteca']] }
      },
      { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: '✅ Visto' }] }
    ]
  })
});

console.log(`Template criado: id ${criado.id}, status ${criado.status}, categoria ${criado.category}`);
