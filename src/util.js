const TZ = 'America/Sao_Paulo';

// Data de hoje no fuso de Brasília, no formato AAAA-MM-DD.
function hoje(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

// Hora atual 'HH:MM' no fuso de Brasília.
function horaAgora(d = new Date()) {
  return new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
}

function diaSemana(dataISO) {
  const [a, m, d] = dataISO.split('-').map(Number);
  return new Date(Date.UTC(a, m - 1, d, 12)).getUTCDay(); // 0 = domingo, 6 = sábado
}

const NOMES_DIAS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];

function dataPorExtenso(dataISO) {
  const [a, m, d] = dataISO.split('-');
  return `${NOMES_DIAS[diaSemana(dataISO)]}, ${d}/${m}`;
}

function reais(v) {
  return 'R$ ' + Number(v || 0).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

function semAcentos(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Deixa só dígitos; acrescenta 55 quando vier só DDD + número.
function normalizarTelefone(t) {
  let n = String(t || '').replace(/\D/g, '');
  if (n.length === 10 || n.length === 11) n = '55' + n;
  return n;
}

function formatarTelefone(n) {
  const m = String(n).match(/^55(\d{2})(\d{4,5})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : n;
}

module.exports = { TZ, hoje, horaAgora, diaSemana, dataPorExtenso, reais, semAcentos, normalizarTelefone, formatarTelefone };
