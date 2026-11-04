/**
 * O cérebro: manda a conversa para o modelo, executa as ferramentas que ele
 * pedir e repete até ele responder em texto.
 */

import { llm, MODELO_CHAT, MODELOS_RESERVA } from './openai.js';
import { FERRAMENTAS, executarFerramenta } from './ferramentas.js';
import { agoraPorExtenso } from './tempo.js';

// Teto de idas e vindas com ferramentas numa só mensagem. Protege contra o
// modelo entrar em loop e gastar tokens à toa.
const MAX_PASSOS = 8;

export function montarSistema({ memorias = [], categorias = [], agora = new Date() }) {
  const dono = process.env.DONO_NOME || 'o dono deste número';

  const blocoMemorias = memorias.length
    ? memorias.map(m => `#${m.id}: ${m.texto}`).join('\n')
    : '(nenhuma ainda)';

  return `Você é o assistente pessoal de ${dono}, conversando pelo WhatsApp.

Agora: ${agoraPorExtenso(agora)}.

# Como responder
- Português do Brasil, curto e direto, como numa conversa de WhatsApp.
- Formatação do WhatsApp: *negrito*, _itálico_, listas com "•". Nada de # títulos, tabelas ou [links](url).
- Depois de agir, confirme o que fez com os detalhes que importam (ex: dia e hora do lembrete, valor e categoria do gasto).
- Se faltar algo essencial, pergunte. Se der para inferir com segurança, faça.
- Quando uma ferramenta já entregou o conteúdo (figurinha, GIF, transcrição), não repita: responda no máximo uma frase curta, ou nada.

# Lembretes
- Resolva datas relativas ("quarta", "amanhã", "daqui a 2 horas") a partir de agora.
- Sem horário informado, use 09:00. Se o dia citado for hoje e o horário já passou, pergunte.
- Envie "quando" em ISO 8601 com -03:00.

# Finanças
- "gastei", "paguei", "comprei" = gasto; "recebi", "caiu o salário" = receita.
- Categorias já usadas: ${categorias.length ? categorias.join(', ') : '(nenhuma ainda)'}. Reaproveite quando fizer sentido.
- Para "quanto gastei esse mês", consulte do dia 1 até hoje.

# Mídia
- Mensagens com mídia trazem um media_id. Use-o em criar_figurinha ou criar_gif.
- Link de vídeo (YouTube, X, Instagram, TikTok...) = transcrever_video, a menos que o usuário peça outra coisa.

# Memória
Fatos que ${dono} pediu para você saber (use o #id para apagar):
${blocoMemorias}
Salve com salvar_memoria quando ele pedir para lembrar algo, ou quando contar algo duradouro claramente útil no futuro.`;
}

// Lotado (503), cota estourada (429) ou aposentado (404): erros do modelo, não
// do pedido. Vale tentar outro. Qualquer outro erro sobe direto.
const VALE_TROCAR_DE_MODELO = [404, 429, 500, 502, 503, 504];

/**
 * No plano grátis o modelo principal às vezes fica lotado. Em vez de deixar o
 * usuário sem resposta, passa para os modelos de LLM_MODELOS_RESERVA, em ordem.
 */
export async function completarComReserva(cliente, pedido) {
  const modelos = [MODELO_CHAT(), ...MODELOS_RESERVA()];
  let ultimoErro;

  for (const model of modelos) {
    try {
      return await cliente.chat.completions.create({ ...pedido, model });
    } catch (err) {
      if (!VALE_TROCAR_DE_MODELO.includes(err.status)) throw err;
      console.warn(`Modelo ${model} indisponível (${err.status}); tentando o próximo`);
      ultimoErro = err;
    }
  }
  throw ultimoErro;
}

/**
 * @param {object} p
 * @param {Array}  p.historico   mensagens anteriores [{role, content}]
 * @param {string|Array} p.entrada  conteúdo da mensagem atual (texto ou partes com imagem)
 * @param {object} p.ctx         repassado às ferramentas ({ para, wa })
 * @returns {Promise<{texto: string, ferramentasUsadas: string[]}>}
 */
export async function rodarAgente({
  historico = [], entrada, memorias, categorias, ctx,
  cliente = llm(), ferramentas = FERRAMENTAS, agora = new Date()
}) {
  const messages = [
    { role: 'system', content: montarSistema({ memorias, categorias, agora }) },
    ...historico,
    { role: 'user', content: entrada }
  ];
  const tools = ferramentas.map(f => f.definicao);
  const esforco = process.env.LLM_ESFORCO ?? 'low';
  const ferramentasUsadas = [];

  for (let passo = 0; passo < MAX_PASSOS; passo++) {
    const r = await completarComReserva(cliente, {
      messages,
      tools,
      ...(esforco ? { reasoning_effort: esforco } : {})
    });

    const msg = r.choices[0].message;
    messages.push(msg);

    if (!msg.tool_calls?.length) {
      return { texto: (msg.content || '').trim(), ferramentasUsadas };
    }

    for (const chamada of msg.tool_calls) {
      const nome = chamada.function.name;
      let resultado;
      try {
        const args = JSON.parse(chamada.function.arguments || '{}');
        resultado = await executarFerramenta(nome, args, ctx, ferramentas);
      } catch {
        resultado = { erro: 'argumentos não são JSON válido' };
      }
      ferramentasUsadas.push(nome);
      messages.push({ role: 'tool', tool_call_id: chamada.id, content: JSON.stringify(resultado) });
    }
  }

  return {
    texto: '😵 Me enrolei tentando resolver isso. Pode reformular?',
    ferramentasUsadas
  };
}
