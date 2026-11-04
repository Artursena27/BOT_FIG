/**
 * Conversa com o agente pelo terminal, sem WhatsApp. Usa o banco e a OpenAI
 * de verdade (do .env); figurinhas e vídeos são salvos em ./saida.
 *
 *   npm run conversar
 */

import readline from 'node:readline/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import { rodarAgente } from '../lib/agente.js';
import * as memoria from '../lib/memoria.js';
import { categoriasUsadas } from '../lib/financas.js';
import { db } from '../lib/db.js';

const waFalso = {
  async sendText(_para, texto) { console.log(`\n📤 ${texto}\n`); },
  async sendSticker(_para, webp) { await salvar('figurinha.webp', webp); },
  async sendVideo(_para, mp4) { await salvar('gif.mp4', mp4); },
  async downloadMedia() { throw new Error('sem mídia no modo terminal'); }
};

async function salvar(nome, buffer) {
  await mkdir('saida', { recursive: true });
  await writeFile(`saida/${nome}`, buffer);
  console.log(`\n💾 salvo em saida/${nome}\n`);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
console.log('Converse com o agente (Ctrl+C para sair).\n');

try {
  for (;;) {
    const entrada = (await rl.question('você › ')).trim();
    if (!entrada) continue;

    const [historico, memorias, categorias] = await Promise.all([
      memoria.historico(), memoria.listarMemorias(), categoriasUsadas()
    ]);
    const { texto, ferramentasUsadas } = await rodarAgente({
      historico, entrada, memorias, categorias, ctx: { para: 'terminal', wa: waFalso }
    });

    await memoria.registrarMensagem('user', entrada);
    await memoria.registrarMensagem('assistant', texto || `[usei: ${ferramentasUsadas.join(', ')}]`);

    if (ferramentasUsadas.length) console.log(`   (ferramentas: ${ferramentasUsadas.join(', ')})`);
    console.log(`agente › ${texto}\n`);
  }
} finally {
  rl.close();
  await db().end();
}
