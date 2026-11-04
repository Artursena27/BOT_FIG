import { db } from './db.js';
import { proximaOcorrencia } from './tempo.js';

// Depois disso o lembrete é dado como perdido, para não ficar tentando para
// sempre um envio que falha por motivo permanente (token inválido, etc.).
const MAX_TENTATIVAS = 5;

export const RECORRENCIAS = ['diaria', 'semanal', 'mensal', 'anual'];

export async function criarLembrete({ texto, quando, recorrencia = null }) {
  const [l] = await db()`
    insert into agente.lembretes (texto, quando, recorrencia)
    values (${texto}, ${quando}, ${recorrencia})
    returning id, texto, quando, recorrencia
  `;
  return l;
}

/** Pendentes e os que ficaram presos fora da janela de 24h. */
export async function listarLembretes() {
  return db()`
    select id, texto, quando, recorrencia, (enviado_em is not null) as atrasado
    from agente.lembretes
    where enviado_em is null or not entregue
    order by quando
  `;
}

export async function cancelarLembrete(id) {
  const linhas = await db()`
    delete from agente.lembretes
    where id = ${id} and (enviado_em is null or not entregue)
    returning id
  `;
  return linhas.length > 0;
}

/**
 * Dispara os lembretes vencidos. Chamado pelo /api/tick quando o pg_cron vê
 * que há algum.
 *
 * Primeiro "reserva" as linhas marcando enviado_em numa única instrução, com
 * SKIP LOCKED: se dois ticks se sobrepuserem, cada lembrete sai uma vez só.
 *
 * @param {(lembrete) => Promise<boolean>} entregar
 *        true = chegou; false = Meta recusou fora da janela (fica atrasado);
 *        exceção = falha transitória, tenta de novo no próximo minuto.
 */
export async function dispararVencidos(entregar) {
  const sql = db();
  const vencidos = await sql`
    update agente.lembretes set enviado_em = now(), tentativas = tentativas + 1
    where id in (
      select id from agente.lembretes
      where enviado_em is null and quando <= now()
      order by quando
      limit 20
      for update skip locked
    )
    returning id, texto, quando, recorrencia, tentativas
  `;

  const resultado = { entregues: 0, atrasados: 0, falhas: 0 };

  for (const l of vencidos) {
    let chegou;
    try {
      chegou = await entregar(l);
    } catch (err) {
      console.error(`Lembrete ${l.id} falhou (tentativa ${l.tentativas}):`, err.message);
      resultado.falhas++;
      // Devolve para a fila, a menos que já tenha esgotado as tentativas.
      if (l.tentativas < MAX_TENTATIVAS) {
        await sql`update agente.lembretes set enviado_em = null where id = ${l.id}`;
        continue;
      }
      chegou = false;
    }

    if (chegou) {
      await sql`update agente.lembretes set entregue = true where id = ${l.id}`;
      resultado.entregues++;
    } else {
      resultado.atrasados++;
    }

    // A próxima ocorrência é um lembrete novo, independente deste ter chegado.
    if (l.recorrencia) {
      let proximo = proximaOcorrencia(l.quando, l.recorrencia);
      // Se o sistema ficou parado, pula ocorrências passadas em vez de
      // disparar todas de uma vez.
      while (proximo <= new Date()) proximo = proximaOcorrencia(proximo, l.recorrencia);
      await criarLembrete({ texto: l.texto, quando: proximo, recorrencia: l.recorrencia });
    }
  }

  return resultado;
}

/**
 * Manda um lembrete para o dono. Tenta texto livre; se a Meta recusar por
 * estar fora da janela de 24h, usa o template aprovado.
 *
 * @returns {Promise<boolean>} false = não deu nem com template (fica atrasado)
 */
export async function entregarLembrete(l, wa, para = process.env.DONO_WHATSAPP?.split(',')[0]) {
  try {
    await wa.sendText(para, `🔔 *Lembrete:* ${l.texto}`);
    return true;
  } catch (err) {
    if (!wa.foraDaJanela(err)) throw err;
  }

  const template = process.env.LEMBRETE_TEMPLATE ?? 'lembrete';
  if (!template) return false;

  try {
    // Parâmetro de template não aceita quebra de linha nem espaços em sequência.
    const texto = l.texto.replace(/\s+/g, ' ').slice(0, 900);
    await wa.sendTemplate(para, template, process.env.LEMBRETE_TEMPLATE_IDIOMA || 'pt_BR', [texto]);
    return true;
  } catch (err) {
    console.warn(`Template "${template}" falhou para o lembrete ${l.id}:`, err.message);
    return false;
  }
}

/**
 * Lembretes que a Meta recusou fora da janela. Assim que o dono manda qualquer
 * mensagem a janela reabre, e eles saem antes da resposta.
 */
export async function pegarAtrasados() {
  return db()`
    update agente.lembretes set entregue = true
    where enviado_em is not null and not entregue
    returning id, texto, quando
  `;
}
