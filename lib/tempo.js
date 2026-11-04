/**
 * Datas no fuso do dono. O servidor da Vercel roda em UTC; tudo que o usuário
 * vê ou fala ("quarta às 9h") é horário de Brasília.
 *
 * O Brasil não tem horário de verão desde 2019, então o deslocamento é fixo
 * em -03:00. Isso deixa a aritmética de recorrência trivial.
 */

export const FUSO = 'America/Sao_Paulo';
const DESLOCAMENTO_MS = -3 * 60 * 60 * 1000;

/** Data atual por extenso, para o modelo resolver "amanhã", "quarta", etc. */
export function agoraPorExtenso(agora = new Date()) {
  const data = new Intl.DateTimeFormat('pt-BR', {
    timeZone: FUSO,
    weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  }).format(agora);
  return `${data} (horário de Brasília, UTC-03:00)`;
}

/** "qua, 05/11 às 09:00" */
export function formatarDataHora(data) {
  const d = new Date(data);
  const dia = new Intl.DateTimeFormat('pt-BR', {
    timeZone: FUSO, weekday: 'short', day: '2-digit', month: '2-digit'
  }).format(d).replace('.', '');
  const hora = new Intl.DateTimeFormat('pt-BR', {
    timeZone: FUSO, hour: '2-digit', minute: '2-digit'
  }).format(d);
  return `${dia} às ${hora}`;
}

/** Data de hoje no fuso, no formato YYYY-MM-DD. */
export function hoje(agora = new Date()) {
  return new Date(agora.getTime() + DESLOCAMENTO_MS).toISOString().slice(0, 10);
}

/**
 * Converte o que o modelo mandou num instante. Aceita ISO com fuso; sem fuso,
 * assume Brasília — o modelo às vezes esquece o "-03:00" e "09:00" sem fuso
 * viraria 06:00 aqui, já que o servidor está em UTC.
 */
export function interpretarInstante(texto) {
  const t = String(texto || '').trim();
  const temFuso = /([zZ]|[+-]\d{2}:?\d{2})$/.test(t);
  const d = new Date(temFuso ? t : `${t}-03:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

const diasNoMes = (ano, mes) => new Date(Date.UTC(ano, mes + 1, 0)).getUTCDate();

/**
 * Próxima ocorrência de um lembrete recorrente.
 *
 * Mensal e anual andam pelo calendário de Brasília, segurando o dia no fim do
 * mês: "todo dia 31" cai em 30/04 e 28/02, em vez de pular para março.
 */
export function proximaOcorrencia(data, recorrencia) {
  const d = new Date(data);

  if (recorrencia === 'diaria') return new Date(d.getTime() + 864e5);
  if (recorrencia === 'semanal') return new Date(d.getTime() + 7 * 864e5);

  if (recorrencia === 'mensal' || recorrencia === 'anual') {
    const local = new Date(d.getTime() + DESLOCAMENTO_MS);
    const passo = recorrencia === 'mensal' ? 1 : 12;
    const total = local.getUTCMonth() + passo;
    const ano = local.getUTCFullYear() + Math.floor(total / 12);
    const mes = total % 12;
    const dia = Math.min(local.getUTCDate(), diasNoMes(ano, mes));

    const proximo = new Date(Date.UTC(
      ano, mes, dia,
      local.getUTCHours(), local.getUTCMinutes(), local.getUTCSeconds()
    ));
    return new Date(proximo.getTime() - DESLOCAMENTO_MS);
  }

  return null;
}
