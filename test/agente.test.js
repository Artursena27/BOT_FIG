import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rodarAgente, montarSistema, completarComReserva } from '../lib/agente.js';
import { DEFINICOES } from '../lib/ferramentas.js';

/** Cliente OpenAI falso que devolve as respostas roteirizadas, em ordem. */
function clienteRoteirizado(respostas) {
  const pedidos = [];
  return {
    pedidos,
    chat: {
      completions: {
        async create(pedido) {
          pedidos.push(structuredClone(pedido));
          const msg = respostas.shift();
          if (!msg) throw new Error('roteiro acabou');
          return { choices: [{ message: msg }] };
        }
      }
    }
  };
}

const chamada = (id, name, args) => ({
  id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) }
});

const ferramentaFalsa = (nome, executar) => ({
  definicao: { type: 'function', function: { name: nome, parameters: { type: 'object', properties: {} } } },
  executar
});

test('executa a ferramenta pedida e devolve o resultado ao modelo', async () => {
  const recebidos = [];
  const ferramentas = [ferramentaFalsa('somar', async (args, ctx) => {
    recebidos.push({ args, ctx });
    return { total: args.a + args.b };
  })];

  const cliente = clienteRoteirizado([
    { role: 'assistant', content: null, tool_calls: [chamada('c1', 'somar', { a: 2, b: 3 })] },
    { role: 'assistant', content: 'Deu 5.' }
  ]);

  const r = await rodarAgente({
    entrada: 'quanto é 2+3?', cliente, ferramentas, ctx: { para: '55' },
    historico: [{ role: 'user', content: 'oi' }, { role: 'assistant', content: 'olá' }]
  });

  assert.equal(r.texto, 'Deu 5.');
  assert.deepEqual(r.ferramentasUsadas, ['somar']);
  assert.deepEqual(recebidos, [{ args: { a: 2, b: 3 }, ctx: { para: '55' } }]);

  // Segunda chamada leva o histórico, a mensagem e o resultado da ferramenta.
  const msgs = cliente.pedidos[1].messages;
  assert.equal(msgs[0].role, 'system');
  assert.deepEqual(msgs.slice(1, 4).map(m => m.content), ['oi', 'olá', 'quanto é 2+3?']);
  assert.deepEqual(msgs.at(-1), { role: 'tool', tool_call_id: 'c1', content: '{"total":5}' });
});

test('erro na ferramenta vira resultado para o modelo explicar', async () => {
  const ferramentas = [ferramentaFalsa('quebrar', async () => { throw new Error('banco fora'); })];
  const cliente = clienteRoteirizado([
    { role: 'assistant', content: null, tool_calls: [chamada('c1', 'quebrar', {}), chamada('c2', 'nao_existe', {})] },
    { role: 'assistant', content: 'Não consegui.' }
  ]);

  const r = await rodarAgente({ entrada: 'x', cliente, ferramentas });
  assert.equal(r.texto, 'Não consegui.');
  const resultados = cliente.pedidos[1].messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content));
  assert.deepEqual(resultados, [{ erro: 'banco fora' }, { erro: 'ferramenta desconhecida: nao_existe' }]);
});

test('argumentos inválidos não derrubam o agente', async () => {
  const cliente = clienteRoteirizado([
    { role: 'assistant', content: null, tool_calls: [chamada('c1', 'somar', '{quebrado')] },
    { role: 'assistant', content: 'ok' }
  ]);
  const r = await rodarAgente({ entrada: 'x', cliente, ferramentas: [ferramentaFalsa('somar', async () => 1)] });
  assert.equal(r.texto, 'ok');
  assert.match(cliente.pedidos[1].messages.at(-1).content, /JSON/);
});

test('para depois de muitos passos em vez de girar para sempre', async () => {
  const loop = Array.from({ length: 20 }, (_, i) =>
    ({ role: 'assistant', content: null, tool_calls: [chamada(`c${i}`, 'somar', {})] }));
  const cliente = clienteRoteirizado(loop);
  const r = await rodarAgente({ entrada: 'x', cliente, ferramentas: [ferramentaFalsa('somar', async () => 1)] });
  assert.match(r.texto, /reformular/);
  assert.equal(cliente.pedidos.length, 8);
});

test('modelo lotado passa para o reserva; erro do pedido não', async () => {
  process.env.LLM_MODELO = 'principal';
  process.env.LLM_MODELOS_RESERVA = 'reserva1, reserva2';
  const tentados = [];
  const erro = status => Object.assign(new Error(`HTTP ${status}`), { status });
  const cliente = {
    chat: { completions: { async create({ model }) {
      tentados.push(model);
      if (model === 'principal') throw erro(503);
      if (model === 'reserva1') throw erro(429);
      return { choices: [{ message: { role: 'assistant', content: 'oi' } }] };
    } } }
  };

  try {
    const r = await completarComReserva(cliente, { messages: [] });
    assert.equal(r.choices[0].message.content, 'oi');
    assert.deepEqual(tentados, ['principal', 'reserva1', 'reserva2']);

    tentados.length = 0;
    cliente.chat.completions.create = async ({ model }) => { tentados.push(model); throw erro(400); };
    await assert.rejects(completarComReserva(cliente, { messages: [] }), /400/);
    assert.deepEqual(tentados, ['principal'], 'pedido inválido não adianta repetir');
  } finally {
    delete process.env.LLM_MODELO;
    delete process.env.LLM_MODELOS_RESERVA;
  }
});

test('prompt de sistema traz data, memórias e categorias', () => {
  const s = montarSistema({
    memorias: [{ id: 7, texto: 'Meu carro é um Palio' }],
    categorias: ['mercado', 'transporte'],
    agora: new Date('2026-11-03T15:00:00Z')
  });
  assert.match(s, /terça-feira, 03\/11\/2026/);
  assert.match(s, /#7: Meu carro é um Palio/);
  assert.match(s, /mercado, transporte/);
});

test('todas as ferramentas têm definição válida e nomes únicos', () => {
  const nomes = DEFINICOES.map(d => d.function.name);
  assert.equal(new Set(nomes).size, nomes.length);
  for (const d of DEFINICOES) {
    assert.equal(d.type, 'function');
    assert.match(d.function.name, /^[a-z_]+$/);
    assert.ok(d.function.description.length > 10, d.function.name);
    assert.equal(d.function.parameters.type, 'object');
    for (const r of d.function.parameters.required) {
      assert.ok(r in d.function.parameters.properties, `${d.function.name}.${r}`);
    }
  }
});
