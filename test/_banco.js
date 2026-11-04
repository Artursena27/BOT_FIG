/**
 * Postgres de verdade, em memória (PGlite), para testar o SQL sem Supabase.
 * Cada arquivo de teste roda num processo próprio, então cada um tem o seu.
 */

import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { db } from '../lib/db.js';

export async function subirBanco() {
  const pg = await PGlite.create();
  await pg.exec(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));

  const porta = 40000 + Math.floor(Math.random() * 20000);
  const servidor = new PGLiteSocketServer({ db: pg, port: porta, host: '127.0.0.1' });
  await servidor.start();
  process.env.DATABASE_URL = `postgres://postgres@127.0.0.1:${porta}/postgres?sslmode=disable`;

  return {
    sql: db(),
    async limpar() {
      await db()`truncate agente.mensagens, agente.memorias, agente.lembretes,
                 agente.transacoes, agente.processadas restart identity`;
    },
    async derrubar() {
      await db().end();
      await servidor.stop();
      await pg.close();
    }
  };
}
