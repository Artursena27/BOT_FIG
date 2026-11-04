/**
 * Dispara lembretes vencidos. Chamado pelo pg_cron do Supabase, e só quando
 * há algum vencido (ver db/cron.sql).
 */

import crypto from 'node:crypto';
import * as wa from '../lib/whatsapp.js';
import { dispararVencidos, entregarLembrete } from '../lib/lembretes.js';

function segredoConfere(recebido) {
  const esperado = process.env.CRON_SECRET;
  if (!esperado || !recebido) return false;
  const a = Buffer.from(recebido);
  const b = Buffer.from(esperado);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function POST(request) {
  if (!segredoConfere(request.headers.get('x-cron-secret'))) {
    return new Response('forbidden', { status: 403 });
  }

  const resultado = await dispararVencidos(l => entregarLembrete(l, wa));
  return Response.json(resultado);
}
