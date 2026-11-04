import { db } from './db.js';
import { hoje } from './tempo.js';

const normalizarCategoria = c => String(c || 'outros').trim().toLowerCase();
const reais = v => Number(Number(v).toFixed(2));

export async function registrarTransacao({ tipo, valor, categoria, descricao = null, data = null }) {
  const [t] = await db()`
    insert into agente.transacoes (tipo, valor, categoria, descricao, data)
    values (${tipo}, ${valor}, ${normalizarCategoria(categoria)}, ${descricao}, ${data || hoje()})
    returning id, tipo, valor, categoria, descricao, data
  `;
  return { ...t, valor: reais(t.valor) };
}

export async function apagarTransacao(id) {
  const linhas = await db()`delete from agente.transacoes where id = ${id} returning id`;
  return linhas.length > 0;
}

/**
 * Resumo de um período: totais, quebra por categoria e os lançamentos mais
 * recentes (com id, para o modelo poder apagar um específico).
 */
export async function consultarFinancas({ de, ate, categoria = null, tipo = null }) {
  const sql = db();
  const filtroCategoria = categoria ? sql`and categoria = ${normalizarCategoria(categoria)}` : sql``;
  const filtroTipo = tipo ? sql`and tipo = ${tipo}` : sql``;

  const porCategoria = await sql`
    select tipo, categoria, sum(valor) as total, count(*)::int as quantidade
    from agente.transacoes
    where data between ${de} and ${ate} ${filtroCategoria} ${filtroTipo}
    group by tipo, categoria
    order by total desc
  `;

  const recentes = await sql`
    select id, tipo, valor, categoria, descricao, to_char(data, 'YYYY-MM-DD') as data
    from agente.transacoes
    where data between ${de} and ${ate} ${filtroCategoria} ${filtroTipo}
    order by data desc, id desc
    limit 30
  `;

  const soma = t => reais(porCategoria.filter(c => c.tipo === t).reduce((s, c) => s + Number(c.total), 0));
  const gastos = soma('gasto');
  const receitas = soma('receita');

  return {
    periodo: { de, ate },
    total_gastos: gastos,
    total_receitas: receitas,
    saldo: reais(receitas - gastos),
    por_categoria: porCategoria.map(c => ({ ...c, total: reais(c.total) })),
    lancamentos_recentes: recentes.map(r => ({ ...r, valor: reais(r.valor) }))
  };
}

/** Categorias já usadas, para o modelo reaproveitar em vez de inventar sinônimos. */
export async function categoriasUsadas() {
  const linhas = await db()`select distinct categoria from agente.transacoes order by categoria`;
  return linhas.map(l => l.categoria);
}
