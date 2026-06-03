// src/utils.js — utilitarios puros, sem dependencia de DOM ou IndexedDB.
// Carregado como <script> classico no browser (expoe via window.AppUtils)
// e tambem em ambiente Node (Vitest) via module.exports.
(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) {
        root.AppUtils = api;
        // Compat: nomes ja usados como globais em app.js/db.js
        root.parseValor = api.parseValor;
        root.normSearch = api.normSearch;
        root.formatDateBR = api.formatDateBR;
        root.parseDateBR = api.parseDateBR;
        root.formatMonthLabel = api.formatMonthLabel;
        root.getPrevMonth = api.getPrevMonth;
        root.getNextMonth = api.getNextMonth;
        root.escapeHtml = api.escapeHtml;
        root.fmtBR = api.fmtBR;
    }
})(typeof window !== 'undefined' ? window : null, function () {
    // Parser de valor monetario BR (aceita "1.234,56", "1234.56", " R$ 12,30 ")
    const parseValor = (input) => {
        if (input === null || input === undefined) return NaN;
        let s = String(input).trim().replace(/[R$\s]/g, '');
        if (!s) return NaN;
        if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
        const n = parseFloat(s);
        return isNaN(n) ? NaN : n;
    };

    // Formata numero como moeda BR (sem prefixo R$)
    const fmtBR = (n) => Number(n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    // Normaliza texto para busca (case/acento-insensivel via NFD)
    const normSearch = (s) => (s || '').toString().toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    // ISO YYYY-MM-DD -> DD/MM/YYYY
    const formatDateBR = (dateStr) => {
        if (!dateStr) return '';
        const [year, month, day] = dateStr.split('-');
        if (!year || !month || !day) return '';
        return `${day}/${month}/${year}`;
    };

    // DD/MM/YYYY -> YYYY-MM-DD
    const parseDateBR = (dateBR) => {
        if (!dateBR) return '';
        const [day, month, year] = dateBR.split('/');
        if (!year || !month || !day) return '';
        return `${year}-${month}-${day}`;
    };

    // YYYY-MM -> "Mes/AAAA"
    const formatMonthLabel = (yyyymm) => {
        const [y, m] = (yyyymm || '').split('-').map(Number);
        if (!y || !m) return '';
        const meses = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
        return `${meses[m - 1]}/${y}`;
    };

    // YYYY-MM -> YYYY-MM do mes anterior
    const getPrevMonth = (yyyymm) => {
        const [y, m] = yyyymm.split('-').map(Number);
        const d = new Date(y, m - 2, 1);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    };

    // YYYY-MM -> YYYY-MM do proximo mes
    const getNextMonth = (yyyymm) => {
        const [y, m] = yyyymm.split('-').map(Number);
        const d = new Date(y, m, 1);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    };

    // Escape HTML basico (para uso em template strings)
    const escapeHtml = (s) => (s || '').toString()
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

    return {
        parseValor, fmtBR, normSearch,
        formatDateBR, parseDateBR,
        formatMonthLabel, getPrevMonth, getNextMonth,
        escapeHtml
    };
});
