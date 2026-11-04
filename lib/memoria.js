/**
 * Memória do agente em dois níveis:
 *   - histórico: as últimas mensagens da conversa (contexto de curto prazo);
 *   - memórias: fatos que o dono quer que o agente saiba sempre.
 */

import { db } from './db.js';

// Quantas mensagens anteriores vão para o modelo. Mais que isso encarece cada
// resposta sem ajudar: o que importa a longo prazo vira memória.
const LIMITE_HISTORICO = 20;

export async function registrarMensagem(papel, conteudo) {
  if (!conteudo) return;
  await db()`insert into agente.mensagens (papel, conteudo) values (${papel}, ${conteudo})`;
}

/** Últimas mensagens, da mais antiga para a mais nova. */
export async function historico(limite = LIMITE_HISTORICO) {
  const linhas = await db()`
    select papel, conteudo from agente.mensagens
    order by criado_em desc, id desc
    limit ${limite}
  `;
  return linhas.reverse().map(l => ({ role: l.papel, content: l.conteudo }));
}

export async function salvarMemoria(texto) {
  const [m] = await db()`insert into agente.memorias (texto) values (${texto}) returning id, texto`;
  return m;
}

export async function apagarMemoria(id) {
  const linhas = await db()`delete from agente.memorias where id = ${id} returning id`;
  return linhas.length > 0;
}

export async function listarMemorias() {
  return db()`select id, texto from agente.memorias order by id`;
}
