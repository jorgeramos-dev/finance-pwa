// tests/utils.test.js
const U = require('../src/utils.js');

describe('parseValor', () => {
    it('aceita formato BR com virgula e milhar', () => {
        expect(U.parseValor('1.234,56')).toBe(1234.56);
    });
    it('aceita formato pt-BR simples', () => {
        expect(U.parseValor('12,30')).toBe(12.30);
    });
    it('aceita formato US com ponto', () => {
        expect(U.parseValor('1234.56')).toBe(1234.56);
    });
    it('aceita prefixo R$ e espacos', () => {
        expect(U.parseValor(' R$ 350,90 ')).toBe(350.90);
    });
    it('retorna NaN para vazio/null/undefined', () => {
        expect(U.parseValor('')).toBeNaN();
        expect(U.parseValor(null)).toBeNaN();
        expect(U.parseValor(undefined)).toBeNaN();
    });
    it('retorna NaN para texto invalido', () => {
        expect(U.parseValor('abc')).toBeNaN();
    });
});

describe('normSearch', () => {
    it('remove acentos e baixa caixa', () => {
        expect(U.normSearch('Alimentação')).toBe('alimentacao');
        expect(U.normSearch('Saúde')).toBe('saude');
        expect(U.normSearch('Educação')).toBe('educacao');
    });
    it('lida com vazio/null', () => {
        expect(U.normSearch('')).toBe('');
        expect(U.normSearch(null)).toBe('');
        expect(U.normSearch(undefined)).toBe('');
    });
    it('aceita numero', () => {
        expect(U.normSearch(42)).toBe('42');
    });
});

describe('formatDateBR / parseDateBR', () => {
    it('formata ISO para BR', () => {
        expect(U.formatDateBR('2026-06-03')).toBe('03/06/2026');
    });
    it('retorna vazio para input invalido', () => {
        expect(U.formatDateBR('')).toBe('');
        expect(U.formatDateBR(null)).toBe('');
        expect(U.formatDateBR('xx')).toBe('');
    });
    it('parseDateBR inverte formatDateBR', () => {
        expect(U.parseDateBR('03/06/2026')).toBe('2026-06-03');
    });
});

describe('formatMonthLabel', () => {
    it('formata YYYY-MM em rotulo curto', () => {
        expect(U.formatMonthLabel('2026-01')).toBe('Jan/2026');
        expect(U.formatMonthLabel('2026-12')).toBe('Dez/2026');
    });
    it('retorna vazio para input invalido', () => {
        expect(U.formatMonthLabel('')).toBe('');
        expect(U.formatMonthLabel(null)).toBe('');
    });
});

describe('getPrevMonth / getNextMonth', () => {
    it('avanca/recua entre meses no mesmo ano', () => {
        expect(U.getPrevMonth('2026-06')).toBe('2026-05');
        expect(U.getNextMonth('2026-06')).toBe('2026-07');
    });
    it('lida com virada de ano', () => {
        expect(U.getPrevMonth('2026-01')).toBe('2025-12');
        expect(U.getNextMonth('2026-12')).toBe('2027-01');
    });
});

describe('escapeHtml', () => {
    it('escapa caracteres perigosos', () => {
        expect(U.escapeHtml('<script>alert("x")</script>'))
            .toBe('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    });
    it('escapa apostrofo e e-comercial', () => {
        expect(U.escapeHtml(`O'Brien & Co`)).toBe('O&#39;Brien &amp; Co');
    });
    it('lida com vazio/null', () => {
        expect(U.escapeHtml('')).toBe('');
        expect(U.escapeHtml(null)).toBe('');
    });
});

describe('fmtBR', () => {
    it('formata com 2 casas decimais', () => {
        expect(U.fmtBR(1234.5)).toBe('1.234,50');
        expect(U.fmtBR(0)).toBe('0,00');
    });
    it('trata null/undefined como zero', () => {
        expect(U.fmtBR(null)).toBe('0,00');
        expect(U.fmtBR(undefined)).toBe('0,00');
    });
});
