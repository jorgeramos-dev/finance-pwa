// vitest.config.js
// jsdom para utils que dependem de TextEncoder/crypto (security.js).
// Mantemos os arquivos src/*.js como CommonJS (compativel com browser tambem)
// e os testes os carregam via require().
module.exports = {
    test: {
        environment: 'jsdom',
        include: ['tests/**/*.test.js'],
        globals: true,
        reporters: ['default']
    }
};
