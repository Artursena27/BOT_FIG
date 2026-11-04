-- O relógio dos lembretes.
--
-- A Vercel grátis só roda cron uma vez por dia. O pg_cron do Supabase roda a
-- cada minuto de graça, mas só faz uma consulta barata: chama a Vercel apenas
-- quando existe lembrete vencido. Não há função acordando à toa 1440 vezes por dia.
--
-- Separado do schema.sql porque pg_cron/pg_net só existem no Supabase — o
-- banco de teste local não tem essas extensões.

create extension if not exists pg_cron;
create extension if not exists pg_net;

create or replace function agente.verificar_lembretes() returns void
language plpgsql security definer as $$
declare
  url     text;
  segredo text;
begin
  if not exists (
    select 1 from agente.lembretes where enviado_em is null and quando <= now()
  ) then
    return;
  end if;

  select valor into url     from agente.config where chave = 'tick_url';
  select valor into segredo from agente.config where chave = 'cron_secret';
  if url is null or segredo is null then
    raise warning 'agente.config sem tick_url/cron_secret — rode npm run db:setup';
    return;
  end if;

  perform net.http_post(
    url := url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', segredo),
    body := '{}'::jsonb,
    timeout_milliseconds := 10000
  );
end;
$$;

-- cron.schedule com um nome que já existe atualiza o job em vez de duplicar.
select cron.schedule('agente-lembretes', '* * * * *', 'select agente.verificar_lembretes()');

-- Faxina diária: ids de webhook só importam por alguns minutos.
select cron.schedule(
  'agente-faxina',
  '0 7 * * *',
  $$delete from agente.processadas where criado_em < now() - interval '7 days'$$
);
