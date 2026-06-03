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

// v2: categorias + campos categoria/recorrente em entradas/saidas
db.version(2).stores({
  config: "key",
  entradas: "++id, descricao, valor, data, categoria, recorrente",
  saidas: "++id, descricao, valor, data, tipo, status, categoria, recorrente",
  dividas: "++id, nome, valorOriginal, saldoDevedor, vencimento",
  poupanca: "++id, tipo, valor, data",
  metas: "++id, nome, valorAlvo, valorGuardado, dataLimite",
  categorias: "++id, nome, kind, &[kind+nome]" // unicidade por (kind, nome)
}).upgrade(async (tx) => {
  // Preenche defaults nos registros antigos para nao quebrar filtros/buscas
  await tx.table('entradas').toCollection().modify((it) => {
    if (it.categoria === undefined) it.categoria = 'Outros';
    if (it.recorrente === undefined) it.recorrente = 0;
  });
  await tx.table('saidas').toCollection().modify((it) => {
    if (it.categoria === undefined) it.categoria = 'Outros';
    if (it.recorrente === undefined) it.recorrente = 0;
  });
  // Seed inicial de categorias
  const seeds = [
    // Entradas
    { nome: 'Salário', kind: 'entrada' },
    { nome: 'Freelance', kind: 'entrada' },
    { nome: 'Investimentos', kind: 'entrada' },
    { nome: 'Outros', kind: 'entrada' },
    // Saídas
    { nome: 'Alimentação', kind: 'saida' },
    { nome: 'Transporte', kind: 'saida' },
    { nome: 'Moradia', kind: 'saida' },
    { nome: 'Saúde', kind: 'saida' },
    { nome: 'Educação', kind: 'saida' },
    { nome: 'Lazer', kind: 'saida' },
    { nome: 'Assinaturas', kind: 'saida' },
    { nome: 'Outros', kind: 'saida' }
  ];
  for (const s of seeds) {
    try { await tx.table('categorias').add(s); } catch (_) { /* dup */ }
  }
});

// formatDateBR/parseDateBR foram movidos para src/utils.js (carregado antes deste arquivo)

// Garante que a tabela de categorias tenha as opcoes padrao (idempotente,
// funciona tanto em DB novo quanto em upgrade da v1)
const DEFAULT_CATEGORIAS = [
  { nome: 'Salário', kind: 'entrada' },
  { nome: 'Freelance', kind: 'entrada' },
  { nome: 'Investimentos', kind: 'entrada' },
  { nome: 'Outros', kind: 'entrada' },
  { nome: 'Alimentação', kind: 'saida' },
  { nome: 'Transporte', kind: 'saida' },
  { nome: 'Moradia', kind: 'saida' },
  { nome: 'Saúde', kind: 'saida' },
  { nome: 'Educação', kind: 'saida' },
  { nome: 'Lazer', kind: 'saida' },
  { nome: 'Assinaturas', kind: 'saida' },
  { nome: 'Outros', kind: 'saida' }
];
async function ensureCategoriasSeed() {
  const count = await db.categorias.count();
  if (count > 0) return;
  for (const s of DEFAULT_CATEGORIAS) {
    try { await db.categorias.add(s); } catch (_) { /* dup */ }
  }
}

// Exportar db para uso no app.js
window.db = db;
window.ensureCategoriasSeed = ensureCategoriasSeed;
