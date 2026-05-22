// Configuração do Banco de Dados com Dexie.js
const db = new Dexie("FinancePWA");

db.version(1).stores({
  config: "key", // Para PIN e configurações globais
  entradas: "++id, descricao, valor, data",
  saidas: "++id, descricao, valor, data, tipo, status", // tipo: fixa/variavel, status: pago/pendente
  dividas: "++id, nome, valorOriginal, saldoDevedor, vencimento",
  poupanca: "++id, tipo, valor, data", // tipo: reserva/investimento
  metas: "++id, nome, valorAlvo, valorGuardado, dataLimite"
});

// Funções auxiliares de formatação de data para o padrão brasileiro
const formatDateBR = (dateStr) => {
  if (!dateStr) return "";
  const [year, month, day] = dateStr.split("-");
  return `${day}/${month}/${year}`;
};

const parseDateBR = (dateBR) => {
  if (!dateBR) return "";
  const [day, month, year] = dateBR.split("/");
  return `${year}-${month}-${day}`;
};

// Exportar db para uso no app.js
window.db = db;
window.formatDateBR = formatDateBR;
window.parseDateBR = parseDateBR;
