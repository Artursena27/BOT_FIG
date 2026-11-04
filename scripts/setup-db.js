/**
 * Cria/atualiza as tabelas e o relógio dos lembretes no Supabase.
 *
 *   npm run db:setup
 *
 * Lê do .env: DATABASE_URL, APP_URL (ex: https://meu-agente.vercel.app) e
 * CRON_SECRET. Pode rodar quantas vezes quiser — tudo é idempotente.
 */

import { readFile } from 'node:fs/promises';
import postgres from 'postgres';

const faltando = ['DATABASE_URL', 'APP_URL', 'CRON_SECRET'].filter(v => !process.env[v]);
if (faltando.length) {
  console.error(`Faltam variáveis no .env: ${faltando.join(', ')}`);
  process.exit(1);
}

const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1, onnotice: () => {} });
const arquivo = nome => readFile(new URL(`../db/${nome}`, import.meta.url), 'utf8');

try {
  await sql.unsafe(await arquivo('schema.sql'));
  console.log('✅ Tabelas criadas/atualizadas');

  const tickUrl = `${process.env.APP_URL.replace(/\/+$/, '')}/api/tick`;
  await sql`
    insert into agente.config (chave, valor) values
      ('tick_url', ${tickUrl}),
      ('cron_secret', ${process.env.CRON_SECRET})
    on conflict (chave) do update set valor = excluded.valor
  `;
  console.log(`✅ pg_cron vai chamar ${tickUrl}`);

  await sql.unsafe(await arquivo('cron.sql'));
  console.log('✅ Relógio dos lembretes agendado (pg_cron, a cada minuto)');
} catch (err) {
  console.error('❌', err.message);
  if (/pg_cron|pg_net/.test(err.message)) {
    console.error('   Ative as extensões pg_cron e pg_net no painel do Supabase ' +
                  '(Database → Extensions) e rode de novo.');
  }
  process.exitCode = 1;
} finally {
  await sql.end();
}
