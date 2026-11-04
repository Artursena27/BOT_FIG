/**
 * Diz se a configuração está completa, sem revelar valores. Útil logo depois
 * do deploy: abra /api/health no navegador.
 */

const OBRIGATORIAS = [
  'WHATSAPP_TOKEN', 'PHONE_NUMBER_ID', 'VERIFY_TOKEN', 'APP_SECRET',
  'DATABASE_URL', 'DONO_WHATSAPP', 'CRON_SECRET'
];

// Cada papel aceita a própria chave ou cai na da OpenAI.
const CHAVES_DE_IA = ['LLM_API_KEY', 'TRANSCRICAO_API_KEY'];

export function GET() {
  const faltando = OBRIGATORIAS.filter(v => !process.env[v]);
  if (!process.env.OPENAI_API_KEY) {
    faltando.push(...CHAVES_DE_IA.filter(v => !process.env[v]));
  }
  return Response.json(
    { ok: faltando.length === 0, faltando },
    { status: faltando.length ? 500 : 200 }
  );
}
