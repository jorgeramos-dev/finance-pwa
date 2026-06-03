// src/security.js — hashing de PIN com PBKDF2 + salt usando SubtleCrypto.
// Carregado como <script> classico no browser (window.AppSecurity)
// e em ambiente Node (Vitest) via module.exports. Em Node assume globalThis.crypto.
(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) {
        root.AppSecurity = api;
        root.hashPin = api.hashPin;
        root.verifyPin = api.verifyPin;
    }
})(typeof window !== 'undefined' ? window : null, function () {
    const getCrypto = () => (typeof globalThis !== 'undefined' && globalThis.crypto) || (typeof window !== 'undefined' ? window.crypto : null);

    const toHex = (buf) => Array.from(new Uint8Array(buf))
        .map(b => b.toString(16).padStart(2, '0')).join('');

    const fromHex = (hex) => {
        const a = new Uint8Array(hex.length / 2);
        for (let i = 0; i < a.length; i++) a[i] = parseInt(hex.substr(i * 2, 2), 16);
        return a;
    };

    // hashPin(pin[, saltHex]) -> { salt, hash } (ambos em hex)
    // Se saltHex nao for fornecido, gera 16 bytes aleatorios.
    const hashPin = async (pin, saltHex) => {
        const cr = getCrypto();
        if (!cr || !cr.subtle) throw new Error('SubtleCrypto indisponivel');
        const enc = new TextEncoder();
        const salt = saltHex ? fromHex(saltHex) : cr.getRandomValues(new Uint8Array(16));
        const key = await cr.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits']);
        const bits = await cr.subtle.deriveBits(
            { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
            key, 256
        );
        return { salt: toHex(salt), hash: toHex(bits) };
    };

    // verifyPin(pin, stored) -> boolean.
    // stored.value pode ser:
    //   - string (legado: PIN em claro)
    //   - { salt, hash } (formato atual)
    const verifyPin = async (pin, stored) => {
        if (!stored) return false;
        if (typeof stored.value === 'string') return stored.value === pin;
        const { salt, hash } = stored.value || {};
        if (!salt || !hash) return false;
        const r = await hashPin(pin, salt);
        return r.hash === hash;
    };

    return { hashPin, verifyPin, _toHex: toHex, _fromHex: fromHex };
});
