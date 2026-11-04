import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proximaOcorrencia, interpretarInstante, hoje, formatarDataHora } from '../lib/tempo.js';

test('interpretarInstante assume Brasília quando o modelo esquece o fuso', () => {
  assert.equal(interpretarInstante('2026-11-05T09:00:00').toISOString(), '2026-11-05T12:00:00.000Z');
  assert.equal(interpretarInstante('2026-11-05T09:00:00-03:00').toISOString(), '2026-11-05T12:00:00.000Z');
  assert.equal(interpretarInstante('2026-11-05T12:00:00Z').toISOString(), '2026-11-05T12:00:00.000Z');
  assert.equal(interpretarInstante('quarta que vem'), null);
});

test('hoje usa a data de Brasília, não a de UTC', () => {
  // 01:30 UTC do dia 4 ainda é 22:30 do dia 3 em Brasília
  assert.equal(hoje(new Date('2026-11-04T01:30:00Z')), '2026-11-03');
});

test('recorrência diária e semanal', () => {
  const base = new Date('2026-11-05T12:00:00Z');
  assert.equal(proximaOcorrencia(base, 'diaria').toISOString(), '2026-11-06T12:00:00.000Z');
  assert.equal(proximaOcorrencia(base, 'semanal').toISOString(), '2026-11-12T12:00:00.000Z');
});

test('recorrência mensal segura o dia no fim do mês', () => {
  // 31/01 09:00 em Brasília
  const jan31 = new Date('2026-01-31T12:00:00Z');
  const fev = proximaOcorrencia(jan31, 'mensal');
  assert.equal(fev.toISOString(), '2026-02-28T12:00:00.000Z');
});

test('recorrência mensal respeita o dia em Brasília perto da meia-noite', () => {
  // 31/01 23:30 em Brasília = 01/02 02:30 UTC; o próximo é 28/02 23:30 local
  const r = proximaOcorrencia(new Date('2026-02-01T02:30:00Z'), 'mensal');
  assert.equal(r.toISOString(), '2026-03-01T02:30:00.000Z');
});

test('recorrência anual e virada de ano', () => {
  assert.equal(
    proximaOcorrencia(new Date('2026-12-15T12:00:00Z'), 'mensal').toISOString(),
    '2027-01-15T12:00:00.000Z'
  );
  assert.equal(
    proximaOcorrencia(new Date('2028-02-29T12:00:00Z'), 'anual').toISOString(),
    '2029-02-28T12:00:00.000Z'
  );
});

test('formatarDataHora mostra horário de Brasília', () => {
  assert.match(formatarDataHora('2026-11-05T12:00:00Z'), /05\/11 às 09:00/);
});
