import postgres from 'postgres';

let sql;

/**
 * Conexão única por instância da função.
 *
 * Use a connection string do *Transaction pooler* do Supabase (porta 6543): a
 * Vercel abre muitas instâncias curtas, e o pooler evita esgotar as conexões
 * do Postgres. O pooler em modo transação não suporta prepared statements,
 * daí o `prepare: false`.
 */
export function db() {
  if (!sql) {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL não configurada');
    sql = postgres(process.env.DATABASE_URL, {
      prepare: false,
      max: 3,
      idle_timeout: 20,
      connect_timeout: 10
    });
  }
  return sql;
}
