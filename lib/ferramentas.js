/**
 * Ferramentas que o agente pode chamar.
 *
 * Para dar uma habilidade nova ao agente, acrescente um item em FERRAMENTAS:
 * `definicao` é o que o modelo vê (nome, quando usar, parâmetros) e
 * `executar` é o que roda. O retorno vai de volta para o modelo como JSON,
 * e ele usa isso para escrever a resposta.
 *
 * `ctx` traz quem está falando (`para`) e o cliente do WhatsApp (`wa`), para
 * ferramentas que entregam mídia direto em vez de só devolver texto.
 */

import * as lembretes from './lembretes.js';
import * as financas from './financas.js';
import * as memoria from './memoria.js';
import * as midia from './midia.js';
import { transcreverLink } from './transcricao.js';
import { geradorDeImagem, MODELO_IMAGEM, temGeradorDeImagem } from './openai.js';
import { interpretarInstante, formatarDataHora } from './tempo.js';

const funcao = (name, description, properties = {}, required = []) => ({
  type: 'function',
  function: {
    name,
    description,
    parameters: { type: 'object', properties, required, additionalProperties: false }
  }
});

const ehVideo = mime => /^video\//.test(mime) || mime === 'image/gif';

async function gerarImagemDeFigurinha(descricao) {
  const prompt =
    `${descricao}. Estilo figurinha de WhatsApp: um único elemento centralizado, ` +
    'contorno branco grosso, cores vivas, fundo transparente, sem texto a menos que pedido.';
  const pedido = { model: MODELO_IMAGEM(), prompt, size: '1024x1024', quality: 'low', output_format: 'png' };

  let r;
  try {
    r = await geradorDeImagem().images.generate({ ...pedido, background: 'transparent' });
  } catch (err) {
    // Nem todo modelo aceita fundo transparente; melhor figurinha com fundo do que nenhuma.
    if (!/background/i.test(err.message)) throw err;
    r = await geradorDeImagem().images.generate(pedido);
  }
  return Buffer.from(r.data[0].b64_json, 'base64');
}

export const FERRAMENTAS = [
  // ── Lembretes ────────────────────────────────────────────────────────────
  {
    definicao: funcao(
      'criar_lembrete',
      'Agenda um lembrete que será enviado ao usuário no WhatsApp na data e hora indicadas.',
      {
        texto: { type: 'string', description: 'O que lembrar, curto e direto. Ex: "Renovar o livro na biblioteca".' },
        quando: { type: 'string', description: 'Data e hora em ISO 8601 com fuso de Brasília. Ex: "2026-11-05T09:00:00-03:00".' },
        recorrencia: { type: 'string', enum: lembretes.RECORRENCIAS, description: 'Só se o usuário pedir repetição.' }
      },
      ['texto', 'quando']
    ),
    async executar({ texto, quando, recorrencia }) {
      const instante = interpretarInstante(quando);
      if (!instante) return { erro: `data inválida: "${quando}"` };
      if (instante <= new Date()) return { erro: 'essa data já passou; confirme com o usuário' };
      const l = await lembretes.criarLembrete({ texto, quando: instante, recorrencia: recorrencia || null });
      return { id: l.id, texto: l.texto, quando: formatarDataHora(l.quando), recorrencia: l.recorrencia };
    }
  },
  {
    definicao: funcao('listar_lembretes', 'Lista os lembretes ainda não enviados.'),
    async executar() {
      const lista = await lembretes.listarLembretes();
      return lista.map(l => ({ ...l, quando: formatarDataHora(l.quando) }));
    }
  },
  {
    definicao: funcao(
      'cancelar_lembrete',
      'Cancela um lembrete pelo id. Use listar_lembretes antes se não souber o id.',
      { id: { type: 'integer' } },
      ['id']
    ),
    async executar({ id }) {
      return { cancelado: await lembretes.cancelarLembrete(id) };
    }
  },

  // ── Finanças ─────────────────────────────────────────────────────────────
  {
    definicao: funcao(
      'registrar_transacao',
      'Registra um gasto ou uma receita do usuário.',
      {
        tipo: { type: 'string', enum: ['gasto', 'receita'] },
        valor: { type: 'number', description: 'Valor em reais, positivo.' },
        categoria: { type: 'string', description: 'Categoria curta em minúsculas. Reaproveite as já usadas.' },
        descricao: { type: 'string' },
        data: { type: 'string', description: 'YYYY-MM-DD. Omita para hoje.' }
      },
      ['tipo', 'valor', 'categoria']
    ),
    async executar(args) {
      if (!(args.valor > 0)) return { erro: 'valor precisa ser positivo' };
      return financas.registrarTransacao(args);
    }
  },
  {
    definicao: funcao(
      'consultar_financas',
      'Totais de gastos e receitas num período, por categoria, com os lançamentos recentes e seus ids.',
      {
        de: { type: 'string', description: 'YYYY-MM-DD' },
        ate: { type: 'string', description: 'YYYY-MM-DD' },
        categoria: { type: 'string' },
        tipo: { type: 'string', enum: ['gasto', 'receita'] }
      },
      ['de', 'ate']
    ),
    async executar(args) {
      return financas.consultarFinancas(args);
    }
  },
  {
    definicao: funcao(
      'apagar_transacao',
      'Apaga um lançamento financeiro pelo id (para corrigir um registro errado).',
      { id: { type: 'integer' } },
      ['id']
    ),
    async executar({ id }) {
      return { apagado: await financas.apagarTransacao(id) };
    }
  },

  // ── Memória ──────────────────────────────────────────────────────────────
  {
    definicao: funcao(
      'salvar_memoria',
      'Guarda um fato duradouro sobre o usuário (preferência, pessoa, data importante, ' +
      'informação que ele pediu para lembrar). Não use para coisas passageiras.',
      { texto: { type: 'string', description: 'O fato, numa frase autocontida.' } },
      ['texto']
    ),
    async executar({ texto }) {
      return memoria.salvarMemoria(texto);
    }
  },
  {
    definicao: funcao(
      'apagar_memoria',
      'Apaga uma memória pelo id (quando ficou errada ou o usuário pediu para esquecer).',
      { id: { type: 'integer' } },
      ['id']
    ),
    async executar({ id }) {
      return { apagada: await memoria.apagarMemoria(id) };
    }
  },

  // ── Figurinhas e GIFs ────────────────────────────────────────────────────
  {
    definicao: funcao(
      'criar_figurinha',
      'Cria e envia uma figurinha. Com media_id, converte a foto/vídeo/GIF recebido ' +
      '(vídeo e GIF viram figurinha animada). Sem media_id, gera uma imagem nova a partir da descrição.',
      {
        media_id: { type: 'string', description: 'O media_id que aparece na mensagem do usuário.' },
        descricao: { type: 'string', description: 'O que desenhar, quando não houver mídia.' },
        inicio: { type: 'number', description: 'Segundo de início no vídeo.' },
        duracao: { type: 'number', description: 'Duração em segundos (máx. 10).' }
      }
    ),
    async executar({ media_id, descricao, inicio, duracao }, ctx) {
      let resultado;
      if (media_id) {
        const { buffer, mime } = await ctx.wa.downloadMedia(media_id);
        resultado = ehVideo(mime)
          ? await midia.figurinhaDeVideo(buffer, { inicio, duracao })
          : await midia.figurinhaDeImagem(buffer);
      } else if (descricao) {
        if (!temGeradorDeImagem()) {
          return { erro: 'gerar figurinha do zero está desligado (sem provedor de imagem). Peça uma foto ou vídeo para converter.' };
        }
        resultado = await midia.figurinhaDeImagem(await gerarImagemDeFigurinha(descricao));
      } else {
        return { erro: 'preciso de media_id ou descricao' };
      }
      await ctx.wa.sendSticker(ctx.para, resultado.webp);
      return { enviada: true, animada: resultado.animada };
    }
  },
  {
    definicao: funcao(
      'criar_gif',
      'Transforma um vídeo ou GIF recebido num GIF (vídeo curto, mudo, em loop) e envia.',
      {
        media_id: { type: 'string' },
        inicio: { type: 'number', description: 'Segundo de início.' },
        duracao: { type: 'number', description: 'Duração em segundos (máx. 15).' }
      },
      ['media_id']
    ),
    async executar({ media_id, inicio, duracao }, ctx) {
      const { buffer, mime } = await ctx.wa.downloadMedia(media_id);
      if (!ehVideo(mime)) return { erro: 'GIF só sai de vídeo ou GIF; para foto, use criar_figurinha' };
      await ctx.wa.sendVideo(ctx.para, await midia.gifDeVideo(buffer, { inicio, duracao }));
      return { enviado: true };
    }
  },

  // ── Transcrição ──────────────────────────────────────────────────────────
  {
    definicao: funcao(
      'transcrever_video',
      'Baixa e transcreve um vídeo por link (YouTube, X/Twitter, Instagram, TikTok...). ' +
      'A transcrição completa é enviada direto ao usuário; você recebe o começo dela.',
      { url: { type: 'string' } },
      ['url']
    ),
    async executar({ url }, ctx) {
      // Leva de 20s a alguns minutos; sem aviso, parece que travou.
      await ctx.wa.sendText(ctx.para, '⏳ Baixando e transcrevendo, pode levar alguns minutos…');
      const { titulo, texto } = await transcreverLink(url);
      if (!texto) return { erro: 'o vídeo não tem fala para transcrever' };

      await ctx.wa.sendText(ctx.para, `📝 *${titulo || 'Transcrição'}*\n\n${texto}`);
      return {
        titulo,
        caracteres: texto.length,
        inicio_da_transcricao: texto.slice(0, 12000),
        aviso: 'A transcrição completa JÁ foi enviada. Não a repita; só responda o que mais o usuário pediu (ex: resumo).'
      };
    }
  }
];

export const DEFINICOES = FERRAMENTAS.map(f => f.definicao);

export async function executarFerramenta(nome, args, ctx, ferramentas = FERRAMENTAS) {
  const f = ferramentas.find(x => x.definicao.function.name === nome);
  if (!f) return { erro: `ferramenta desconhecida: ${nome}` };
  try {
    return await f.executar(args, ctx);
  } catch (err) {
    // Volta para o modelo como resultado, não como exceção: assim ele explica
    // ao usuário o que deu errado em vez de a conversa morrer em silêncio.
    console.error(`Ferramenta ${nome} falhou:`, err);
    return { erro: err.message };
  }
}
