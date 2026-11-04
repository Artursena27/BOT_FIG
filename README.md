# 🤖 Agente pessoal no WhatsApp

Assistente particular que conversa pelo WhatsApp (texto, áudio, foto, vídeo e links)
e executa tarefas:

| Função | Exemplo |
|---|---|
| **Lembretes** | "me avise quarta de renovar o livro" → na quarta às 09:00 chega 🔔 |
| **Finanças** | "gastei 45 no mercado" · "quanto gastei esse mês?" |
| **Memória** | "guarda aí: o aniversário da Maria é 12/03" |
| **Figurinhas** | foto ou vídeo **sem legenda** vira figurinha na hora; "faz uma figurinha de um gato de óculos" gera uma do zero |
| **GIFs** | vídeo com a legenda "faz um gif" |
| **Transcrição** | manda um link do YouTube, X, Instagram ou TikTok |

Áudios são transcritos e tratados como texto, então tudo acima funciona falando.

## Custo: só o da OpenAI

| Peça | Serviço | Plano |
|---|---|---|
| Servidor | Vercel | Hobby (grátis) |
| Banco + relógio dos lembretes | Supabase (Postgres + `pg_cron`) | Free |
| WhatsApp | Meta Cloud API | conversas iniciadas pelo usuário são grátis |
| Cérebro, transcrição, imagens | OpenAI | pago por uso |

A Vercel grátis só roda cron uma vez por dia. Por isso o relógio fica no Supabase:
o `pg_cron` confere a cada minuto se há lembrete vencido e só então chama `/api/tick`.

## Arquitetura

```
WhatsApp ─▶ Meta ─▶ /api/webhook ─▶ lib/bot.js ─▶ lib/agente.js (OpenAI + ferramentas)
                                                        │
                                   lib/ferramentas.js ──┼─ lembretes · finanças · memória
                                                        └─ figurinhas/GIF (ffmpeg, sharp) · transcrição (yt-dlp)
Supabase pg_cron ─(lembrete vencido)─▶ /api/tick ─▶ WhatsApp
```

**Para criar uma função nova**, acrescente um item em `FERRAMENTAS`
([lib/ferramentas.js](lib/ferramentas.js)): uma descrição para o modelo e uma função `executar`.

## Janela de 24h da Meta

O WhatsApp só deixa o bot mandar mensagem livre se você falou com ele nas últimas
24h. Um lembrete marcado para dias depois usa o **template `lembrete`**
(`npm run template` cria). Se o template não estiver aprovado, o lembrete fica
guardado e sai assim que você mandar qualquer mensagem.

## Instalação

1. **Supabase**: crie um projeto e ative as extensões `pg_cron` e `pg_net`
   (Database → Extensions). Copie a connection string do *Transaction pooler*.
2. **Vercel**: importe o repositório. Cadastre as variáveis do [.env.example](.env.example).
3. **Banco**: crie um `.env` local (copie do `.env.example`) e rode `npm run db:setup`.
4. **Template**: `npm run template`.
5. **Meta**: em WhatsApp → Configuration, mude o webhook para
   `https://SEU-PROJETO.vercel.app/api/webhook` (verify token = `VERIFY_TOKEN`)
   e assine o campo `messages`.
6. Abra `https://SEU-PROJETO.vercel.app/api/health`: tem de responder `"ok": true`.

## Desenvolvimento

```bash
npm install
npm test            # 48 testes; o banco roda em memória (PGlite), sem Supabase
npm run conversar   # conversa com o agente no terminal (usa o .env)
```

## Transcrição bloqueada

YouTube e Instagram às vezes bloqueiam downloads vindos de servidores. Se a resposta
for "o site bloqueou o download…", exporte os cookies de uma conta logada (extensão
*Get cookies.txt LOCALLY*, só do domínio necessário) e cole o conteúdo na variável
`YTDLP_COOKIES` da Vercel.
