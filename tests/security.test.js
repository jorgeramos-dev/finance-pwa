// tests/security.test.js
const S = require('../src/security.js');

// jsdom + Node 24 expoem globalThis.crypto com SubtleCrypto.

describe('hashPin', () => {
    it('retorna { salt, hash } em hex', async () => {
        const r = await S.hashPin('1234');
        expect(r).toHaveProperty('salt');
        expect(r).toHaveProperty('hash');
        expect(r.salt).toMatch(/^[0-9a-f]{32}$/); // 16 bytes em hex
        expect(r.hash).toMatch(/^[0-9a-f]{64}$/); // 32 bytes em hex
    });

    it('produz hash diferente para salts diferentes (mesmo PIN)', async () => {
        const a = await S.hashPin('1234');
        const b = await S.hashPin('1234');
        expect(a.salt).not.toBe(b.salt);
        expect(a.hash).not.toBe(b.hash);
    });

    it('e deterministico quando o salt e fixo', async () => {
        const a = await S.hashPin('1234', 'aabbccddeeff00112233445566778899');
        const b = await S.hashPin('1234', 'aabbccddeeff00112233445566778899');
        expect(a.hash).toBe(b.hash);
    });

    it('produz hash diferente para PINs diferentes (mesmo salt)', async () => {
        const salt = '00112233445566778899aabbccddeeff';
        const a = await S.hashPin('1234', salt);
        const b = await S.hashPin('4321', salt);
        expect(a.hash).not.toBe(b.hash);
    });
});

describe('verifyPin', () => {
    it('valida PIN correto contra hash armazenado', async () => {
        const value = await S.hashPin('9999');
        const ok = await S.verifyPin('9999', { value });
        expect(ok).toBe(true);
    });

    it('rejeita PIN incorreto', async () => {
        const value = await S.hashPin('9999');
        const ok = await S.verifyPin('0000', { value });
        expect(ok).toBe(false);
    });

    it('aceita PIN em claro (formato legado) e rejeita errado', async () => {
        const ok = await S.verifyPin('1234', { value: '1234' });
        const nope = await S.verifyPin('5678', { value: '1234' });
        expect(ok).toBe(true);
        expect(nope).toBe(false);
    });

    it('retorna false para stored ausente ou sem hash valido', async () => {
        expect(await S.verifyPin('1234', null)).toBe(false);
        expect(await S.verifyPin('1234', { value: null })).toBe(false);
        expect(await S.verifyPin('1234', { value: {} })).toBe(false);
    });
});

describe('toHex / fromHex (helpers)', () => {
    it('round-trip preserva bytes', () => {
        const buf = new Uint8Array([0, 1, 15, 16, 255]);
        const hex = S._toHex(buf);
        expect(hex).toBe('00010f10ff');
        const back = S._fromHex(hex);
        expect(Array.from(back)).toEqual([0, 1, 15, 16, 255]);
    });
});
