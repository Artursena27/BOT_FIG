import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { subirBanco } from './_banco.js';
import * as lembretes from '../lib/lembretes.js';
import * as financas from '../lib/financas.js';
import * as memoria from '../lib/memoria.js';
import { marcarProcessada } from '../lib/bot.js';
import { hoje } from '../lib/tempo.js';

let banco;
before(async () => { banco = await subirBanco(); });
after(async () => { await banco.derrubar(); });
beforeEach(async () => { await banco.limpar(); });

const minutos = m => new Date(Date.now() + m * 60_000);

// ── Lembretes ──────────────────────────────────────────────────────────────

test('criar, listar e cancelar lembrete', async () => {
  const l = await lembretes.criarLembrete({ texto: 'Renovar o livro', quando: minutos(60) });
  assert.deepEqual((await lembretes.listarLembretes()).map(x => x.texto), ['Renovar o livro']);
  assert.equal(await lembretes.cancelarLembrete(l.id), true);
  assert.equal(await lembretes.cancelarLembrete(l.id), false);
  assert.equal((await lembretes.listarLembretes()).length, 0);
});

test('dispara só os vencidos, uma vez cada', async () => {
  await lembretes.criarLembrete({ texto: 'vencido', quando: minutos(-1) });
  await lembretes.criarLembrete({ texto: 'futuro', quando: minutos(60) });

  const entregues = [];
  const r1 = await lembretes.dispararVencidos(async l => { entregues.push(l.texto); return true; });
  const r2 = await lembretes.dispararVencidos(async l => { entregues.push(l.texto); return true; });

  assert.deepEqual(entregues, ['vencido']);
  assert.deepEqual(r1, { entregues: 1, atrasados: 0, falhas: 0 });
  assert.deepEqual(r2, { entregues: 0, atrasados: 0, falhas: 0 });
  assert.deepEqual((await lembretes.listarLembretes()).map(x => x.texto), ['futuro']);
});

test('fora da janela fica atrasado e sai na próxima mensagem do dono', async () => {
  await lembretes.criarLembrete({ texto: 'pagar boleto', quando: minutos(-5) });
  const r = await lembretes.dispararVencidos(async () => false);
  assert.equal(r.atrasados, 1);

  const pendentes = await lembretes.listarLembretes();
  assert.equal(pendentes[0].atrasado, true);

  const atrasados = await lembretes.pegarAtrasados();
  assert.deepEqual(atrasados.map(a => a.texto), ['pagar boleto']);
  assert.equal((await lembretes.pegarAtrasados()).length, 0, 'não entrega duas vezes');
});

test('falha transitória devolve para a fila; depois de 5 desiste', async () => {
  await lembretes.criarLembrete({ texto: 'instável', quando: minutos(-1) });
  const falhar = async () => { throw new Error('rede'); };

  for (let i = 1; i <= 4; i++) {
    const r = await lembretes.dispararVencidos(falhar);
    assert.equal(r.falhas, 1, `tentativa ${i}`);
    assert.equal((await lembretes.listarLembretes())[0].atrasado, false);
  }

  const r5 = await lembretes.dispararVencidos(falhar);
  assert.deepEqual(r5, { entregues: 0, atrasados: 1, falhas: 1 });
  assert.deepEqual((await lembretes.dispararVencidos(falhar)).falhas, 0);
});

test('recorrente agenda a próxima ocorrência, pulando as que já passaram', async () => {
  // Venceu há 3 dias e o sistema ficou parado: a próxima tem de ser no futuro.
  await lembretes.criarLembrete({ texto: 'remédio', quando: minutos(-3 * 24 * 60 - 1), recorrencia: 'diaria' });
  await lembretes.dispararVencidos(async () => true);

  const [proximo] = await lembretes.listarLembretes();
  assert.equal(proximo.texto, 'remédio');
  assert.equal(proximo.recorrencia, 'diaria');
  assert.ok(proximo.quando > new Date());
  assert.ok(proximo.quando < minutos(24 * 60));
});

test('entregarLembrete usa o template quando a janela está fechada', async () => {
  process.env.LEMBRETE_TEMPLATE = 'lembrete';
  const enviados = [];
  const wa = {
    foraDaJanela: e => /131047/.test(e.message),
    sendText: async () => { throw new Error('{"code":131047}'); },
    sendTemplate: async (...args) => enviados.push(args)
  };
  const ok = await lembretes.entregarLembrete({ id: 1, texto: 'renovar\n  o   livro' }, wa, '5581982267438');
  assert.equal(ok, true);
  assert.deepEqual(enviados, [['5581982267438', 'lembrete', 'pt_BR', ['renovar o livro']]]);

  wa.sendTemplate = async () => { throw new Error('template não aprovado'); };
  assert.equal(await lembretes.entregarLembrete({ id: 1, texto: 'x' }, wa, '55'), false);

  wa.sendText = async () => { throw new Error('token inválido'); };
  await assert.rejects(lembretes.entregarLembrete({ id: 1, texto: 'x' }, wa, '55'), /token/);
});

// ── Finanças ───────────────────────────────────────────────────────────────

test('registra e resume gastos e receitas do período', async () => {
  await financas.registrarTransacao({ tipo: 'gasto', valor: 40.5, categoria: ' Mercado ', descricao: 'feira' });
  await financas.registrarTransacao({ tipo: 'gasto', valor: 9.5, categoria: 'mercado' });
  await financas.registrarTransacao({ tipo: 'gasto', valor: 30, categoria: 'transporte' });
  await financas.registrarTransacao({ tipo: 'receita', valor: 1000, categoria: 'salário' });
  await financas.registrarTransacao({ tipo: 'gasto', valor: 999, categoria: 'mercado', data: '2020-01-01' });

  const r = await financas.consultarFinancas({ de: hoje().slice(0, 8) + '01', ate: hoje() });
  assert.equal(r.total_gastos, 80);
  assert.equal(r.total_receitas, 1000);
  assert.equal(r.saldo, 920);
  assert.deepEqual(
    r.por_categoria.filter(c => c.tipo === 'gasto').map(c => [c.categoria, c.total, c.quantidade]),
    [['mercado', 50, 2], ['transporte', 30, 1]]
  );
  assert.equal(r.lancamentos_recentes.length, 4);
  assert.equal(typeof r.lancamentos_recentes[0].valor, 'number');

  const soMercado = await financas.consultarFinancas({ de: '2000-01-01', ate: hoje(), categoria: 'Mercado' });
  assert.equal(soMercado.total_gastos, 1049);

  assert.deepEqual(await financas.categoriasUsadas(), ['mercado', 'salário', 'transporte']);
});

test('apagar transação', async () => {
  const t = await financas.registrarTransacao({ tipo: 'gasto', valor: 10, categoria: 'x' });
  assert.equal(await financas.apagarTransacao(t.id), true);
  assert.equal(await financas.apagarTransacao(t.id), false);
});

test('o banco recusa valor zero ou negativo', async () => {
  await assert.rejects(financas.registrarTransacao({ tipo: 'gasto', valor: -5, categoria: 'x' }));
});

// ── Memória e histórico ───────────────────────────────────────────────────

test('histórico volta em ordem cronológica e limitado', async () => {
  for (let i = 1; i <= 5; i++) {
    await memoria.registrarMensagem('user', `pergunta ${i}`);
    await memoria.registrarMensagem('assistant', `resposta ${i}`);
  }
  const h = await memoria.historico(4);
  assert.deepEqual(h.map(m => m.content), ['pergunta 4', 'resposta 4', 'pergunta 5', 'resposta 5']);
  assert.deepEqual(h.map(m => m.role), ['user', 'assistant', 'user', 'assistant']);
});

test('salvar, listar e apagar memórias', async () => {
  const m = await memoria.salvarMemoria('Meu carro é um Palio 2012');
  assert.equal(m.id, 1, 'id volta como número, não string');
  assert.deepEqual([...await memoria.listarMemorias()], [{ id: 1, texto: 'Meu carro é um Palio 2012' }]);
  assert.equal(await memoria.apagarMemoria(m.id), true);
  assert.equal((await memoria.listarMemorias()).length, 0);
});

test('marcarProcessada barra a reentrega do mesmo webhook', async () => {
  assert.equal(await marcarProcessada('wamid.X'), true);
  assert.equal(await marcarProcessada('wamid.X'), false);
});
