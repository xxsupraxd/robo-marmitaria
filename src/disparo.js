// Envio do cardápio do dia para todos os contatos, manual (botão no painel) ou automático no horário configurado.
const { load, save } = require('./db');
const config = require('./config');
const cardapio = require('./cardapio');
const contatos = require('./contatos');
const conversas = require('./conversas');
const whatsapp = require('./whatsapp');
const { hoje, horaAgora, dataPorExtenso, reais } = require('./util');

let emAndamento = null;

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function disparar({ origem = 'manual' } = {}) {
  if (emAndamento) throw new Error('Já existe um envio em andamento');
  const cd = cardapio.obter();
  if (!cd || !cd.itens.length) throw new Error('Cadastre o cardápio de hoje antes de enviar');
  // Na API oficial cada mensagem do cardápio é cobrada pela Meta; só envia se alguém ligar isso de propósito.
  if (whatsapp.modo() !== 'simulador' && !config.get().disparo.pelaApiOficial) {
    throw new Error('Envio pela API oficial desligado para não gerar custo. Poste a imagem do cardápio no Status ou nas listas de transmissão.');
  }
  const lista = contatos.listar().filter((c) => c.recebeCardapio !== false);
  const texto = cardapio.textoWhatsApp(cd) + '\n\nPara pedir, responda *1*. Para não receber mais, responda *SAIR*.';
  // Na API oficial, o cardápio da manhã vai no modelo aprovado: "Bom dia! O cardápio de hoje, {{1}}, já saiu: {{2}}. ..."
  const params = [dataPorExtenso(cd.data), resumoUmaLinha(cd)];
  const oficial = whatsapp.modo() !== 'simulador';
  const textoModelo = `Bom dia! 🍽️ O cardápio de hoje, ${params[0]}, já saiu: ${params[1]}. Responda *1* para fazer seu pedido ou *SAIR* para não receber mais.`;
  const registro = { data: hoje(), origem, inicio: new Date().toISOString(), total: lista.length, enviados: 0, falhas: 0, fim: null };
  load().disparos.push(registro);
  save();
  emAndamento = registro;

  (async () => {
    const [min, max] = config.get().disparo.intervaloSegundos || [4, 9];
    for (const ct of lista) {
      try {
        const conv = conversas.obter(ct.telefone, ct.nome);
        const parada = conv.estado === 'inicio' || Date.now() - new Date(conv.atualizadoEm).getTime() > 2 * 3600 * 1000;
        if (oficial) await conversas.enviarModelo(ct.telefone, textoModelo, params, { disparo: true });
        else await conversas.enviar(ct.telefone, texto, 'robo', { disparo: true });
        // Quem responder "1" ao cardápio já cai direto no pedido.
        if (!conv.roboPausado && parada) Object.assign(conv, { estado: 'menu', carrinho: [], rascunho: null, pedidoParcial: {} });
        registro.enviados++;
      } catch {
        registro.falhas++;
      }
      save();
      // Intervalo aleatório entre mensagens para não parecer disparo em massa.
      // (Na API oficial não há esse risco; só uma pausa curta.)
      if (process.env.NODE_ENV !== 'test') await esperar(oficial ? 200 : (min + Math.random() * (max - min)) * 1000);
    }
    registro.fim = new Date().toISOString();
    save();
    emAndamento = null;
  })();

  return registro;
}

// Resumo em uma linha só (parâmetro de modelo da Meta não aceita quebra de linha).
function resumoUmaLinha(cd) {
  return cardapio
    .itensDisponiveis(cd)
    .map((i) => `${i.nome}${i.descricao ? ': ' + i.descricao : ''} (${Object.entries(i.tamanhos).map(([t, p]) => `${t} ${reais(p)}`).join(', ')})`)
    .join(' • ');
}

function status() {
  return { emAndamento, historico: load().disparos.slice(-10).reverse() };
}

// Confere a cada 30s se chegou a hora do envio automático.
function iniciarAgendador() {
  setInterval(() => {
    const cfg = config.get().disparo;
    if (!cfg.automatico || emAndamento) return;
    if (whatsapp.modo() !== 'simulador' && !cfg.pelaApiOficial) return;
    if (horaAgora() < cfg.horario) return;
    if (load().disparos.some((d) => d.data === hoje() && d.origem === 'automatico')) return;
    if (!cardapio.obter()) return; // sem cardápio cadastrado, não envia
    disparar({ origem: 'automatico' }).catch((e) => console.error('Disparo automático:', e.message));
  }, 30 * 1000);
}

module.exports = { disparar, status, iniciarAgendador, resumoUmaLinha };
