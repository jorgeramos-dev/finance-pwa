// app.js - Lógica principal do PWA
document.addEventListener('DOMContentLoaded', async () => {
    // Registrar Service Worker
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('service-worker.js')
            .then(() => console.log('Service Worker registrado com sucesso.'))
            .catch(err => console.error('Erro ao registrar Service Worker:', err));
    }

    // Solicitar armazenamento persistente para reduzir risco de o navegador apagar o IndexedDB
    if (navigator.storage && navigator.storage.persist) {
        navigator.storage.persist().catch(() => {});
    }

    // Garante categorias padrao (idempotente)
    try { await ensureCategoriasSeed(); } catch (err) { console.warn('Seed categorias falhou:', err); }

    // Tema (light | dark | auto). Aplicado o quanto antes para evitar flash.
    const applyTheme = (theme) => {
        const root = document.documentElement;
        let dark;
        if (theme === 'dark') dark = true;
        else if (theme === 'auto') dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        else dark = false;
        root.classList.toggle('dark', dark);
    };
    window.applyTheme = applyTheme;
    try {
        const themeCfg = await db.config.get('theme');
        applyTheme((themeCfg && themeCfg.value) || 'light');
    } catch (_) {}
    if (window.matchMedia) {
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', async () => {
            const cfg = await db.config.get('theme');
            if (cfg && cfg.value === 'auto') applyTheme('auto');
        });
    }

    // Estado da Aplicação
    const state = {
        isLocked: true,
        currentView: 'dashboard',
        charts: {},
        currentMonth: new Date().toISOString().slice(0, 7), // YYYY-MM
        entradasFilter: { mode: 'month', month: new Date().toISOString().slice(0, 7), categoria: 'all', q: '' },
        saidasFilter: { mode: 'month', month: new Date().toISOString().slice(0, 7), status: 'all', tipo: 'all', categoria: 'all', q: '' },
        dividasFilter: { status: 'ativas', sort: 'vencimento', q: '' },
        poupancaFilter: { mode: 'all', month: new Date().toISOString().slice(0, 7), tipo: 'all', q: '' },
        metasFilter: { status: 'ativas', q: '' }
    };

    // Helpers de categorias (cache em memoria, invalidado por refreshCategorias)
    let _categoriasCache = null;
    const getCategorias = async (kind) => {
        if (!_categoriasCache) _categoriasCache = await db.categorias.toArray();
        return kind ? _categoriasCache.filter(c => c.kind === kind) : _categoriasCache;
    };
    const refreshCategorias = () => { _categoriasCache = null; };

    // Helpers puros (parseValor, normSearch, formatDateBR, formatMonthLabel,
    // getPrevMonth, getNextMonth, escapeHtml, fmtBR) vivem em src/utils.js
    // e sao acessiveis como globais. Mantemos aliases locais para legibilidade.
    const { normSearch, formatMonthLabel, getPrevMonth, getNextMonth,
        parseValor, escapeHtml, formatDateBR, fmtBR } = window.AppUtils;

    // Gera lancamentos recorrentes do mes corrente a partir do template (ultimo registro recorrente
    // com o mesmo descricao+categoria). Idempotente: usa db.config['recurringLastRun'] para nao
    // rodar duas vezes no mesmo mes e checa duplicatas antes de inserir.
    async function processRecurring() {
        const nowMonth = new Date().toISOString().slice(0, 7);
        const lastRun = await db.config.get('recurringLastRun');
        if (lastRun && lastRun.value === nowMonth) return;
        const todayISO = new Date().toISOString().slice(0, 10);
        const monthOf = (d) => (d || '').slice(0, 7);
        const dayOf = (d) => parseInt((d || '').slice(8, 10), 10) || 1;
        const adjustToCurrentMonth = (templateDate) => {
            const [y, m] = nowMonth.split('-').map(Number);
            const lastDay = new Date(y, m, 0).getDate();
            const day = Math.min(dayOf(templateDate), lastDay);
            return `${nowMonth}-${String(day).padStart(2, '0')}`;
        };
        let created = 0;
        for (const tableName of ['entradas', 'saidas']) {
            const all = await db[tableName].toArray();
            const templates = all.filter(it => it.recorrente);
            // Agrupa pelo par descricao+categoria, pegando o mais recente como modelo
            const groups = new Map();
            for (const t of templates) {
                const key = `${t.descricao}||${t.categoria || 'Outros'}`;
                const prev = groups.get(key);
                if (!prev || (t.data || '') > (prev.data || '')) groups.set(key, t);
            }
            for (const tpl of groups.values()) {
                // Se ja existe um registro neste mes com mesmo desc+categoria, pula
                const exists = all.some(it => monthOf(it.data) === nowMonth
                    && it.descricao === tpl.descricao
                    && (it.categoria || 'Outros') === (tpl.categoria || 'Outros'));
                if (exists) continue;
                const novo = {
                    descricao: tpl.descricao,
                    valor: parseFloat(tpl.valor) || 0,
                    data: adjustToCurrentMonth(tpl.data || todayISO),
                    categoria: tpl.categoria || 'Outros',
                    recorrente: 1
                };
                if (tableName === 'saidas') {
                    novo.tipo = tpl.tipo || 'fixa';
                    novo.status = 'pendente';
                }
                await db[tableName].add(novo);
                created++;
            }
        }
        await db.config.put({ key: 'recurringLastRun', value: nowMonth });
        if (created > 0) setTimeout(() => toast(`${created} lancamento(s) recorrente(s) gerado(s) para ${formatMonthLabel(nowMonth)}.`, 'info', 4000), 400);
    }

    // parseValor e fmtBR vivem em src/utils.js (alias acima)

    // --- UI Helpers: toast / confirm / prompt ---
    const toast = (msg, type = 'info', ms = 2800) => {
        const c = document.getElementById('toast-container');
        if (!c) { console.log('[toast]', msg); return; }
        const colors = {
            success: 'bg-green-600',
            error: 'bg-red-600',
            warning: 'bg-yellow-500',
            info: 'bg-blue-600'
        };
        const el = document.createElement('div');
        el.className = `toast-enter pointer-events-auto text-white text-sm font-medium px-4 py-2 rounded-lg shadow-lg ${colors[type] || colors.info}`;
        el.textContent = msg;
        c.appendChild(el);
        setTimeout(() => { el.style.transition = 'opacity .25s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 250); }, ms);
    };
    window.toast = toast;

    const openModalHTML = (innerHTML) => {
        const modal = document.getElementById('modal');
        const body = document.getElementById('modal-body');
        body.innerHTML = innerHTML;
        modal.classList.remove('hidden');
        return { modal, body };
    };
    const closeModalUI = () => document.getElementById('modal').classList.add('hidden');

    // confirmDialog → Promise<boolean>
    window.confirmDialog = ({ title = 'Confirmar', message = '', okText = 'Confirmar', cancelText = 'Cancelar', danger = false } = {}) => {
        return new Promise((resolve) => {
            const okClass = danger ? 'bg-red-600 hover:bg-red-700' : 'bg-blue-600 hover:bg-blue-700';
            openModalHTML(`
                <h2 class="text-lg font-bold mb-2">${title}</h2>
                <p class="text-sm text-gray-600 mb-5">${message}</p>
                <div class="flex justify-end gap-2">
                    <button id="cd-cancel" class="px-4 py-2 text-gray-700 rounded hover:bg-gray-100 transition">${cancelText}</button>
                    <button id="cd-ok" class="px-4 py-2 text-white font-medium rounded transition ${okClass}">${okText}</button>
                </div>
            `);
            document.getElementById('cd-cancel').onclick = () => { closeModalUI(); resolve(false); };
            document.getElementById('cd-ok').onclick = () => { closeModalUI(); resolve(true); };
        });
    };

    // promptDialog → Promise<string | null>  (type: 'text' | 'number' | 'money' | 'password')
    window.promptDialog = ({ title = 'Informe um valor', message = '', label = '', type = 'text', placeholder = '', initial = '', okText = 'Salvar', cancelText = 'Cancelar', validate } = {}) => {
        return new Promise((resolve) => {
            const inputType = type === 'password' ? 'password' : (type === 'number' || type === 'money' ? 'text' : 'text');
            const inputMode = (type === 'number' || type === 'money') ? 'decimal' : '';
            openModalHTML(`
                <h2 class="text-lg font-bold mb-2">${title}</h2>
                ${message ? `<p class="text-sm text-gray-600 mb-3">${message}</p>` : ''}
                ${label ? `<label class="block text-xs text-gray-500 mb-1">${label}</label>` : ''}
                <input id="pd-input" type="${inputType}" inputmode="${inputMode}" placeholder="${placeholder}" value="${String(initial).replace(/"/g, '&quot;')}" class="w-full p-2 border-2 border-gray-200 rounded-lg mb-2 focus:border-blue-500 outline-none">
                <p id="pd-err" class="text-xs text-red-600 mb-3 hidden"></p>
                <div class="flex justify-end gap-2">
                    <button id="pd-cancel" class="px-4 py-2 text-gray-700 rounded hover:bg-gray-100 transition">${cancelText}</button>
                    <button id="pd-ok" class="px-4 py-2 bg-blue-600 text-white font-medium rounded hover:bg-blue-700 transition">${okText}</button>
                </div>
            `);
            const input = document.getElementById('pd-input');
            const err = document.getElementById('pd-err');
            setTimeout(() => input.focus(), 50);
            const submit = () => {
                const raw = input.value;
                const msg = validate ? validate(raw) : null;
                if (msg) { err.textContent = msg; err.classList.remove('hidden'); return; }
                closeModalUI(); resolve(raw);
            };
            document.getElementById('pd-cancel').onclick = () => { closeModalUI(); resolve(null); };
            document.getElementById('pd-ok').onclick = submit;
            input.onkeydown = (e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') { closeModalUI(); resolve(null); } };
        });
    };

    // Elementos DOM
    const appContainer = document.getElementById('app');
    const lockScreen = document.getElementById('lock-screen');
    const mainContent = document.getElementById('main-content');
    const pinInput = document.getElementById('pin-input');
    const setPinBtn = document.getElementById('set-pin-btn');
    const unlockBtn = document.getElementById('unlock-btn');
    const forgotPinBtn = document.getElementById('forgot-pin-btn');

    // Inicialização de Segurança
    // hashPin/verifyPin vivem em src/security.js (carregado antes de app.js)
    const { hashPin, verifyPin } = window.AppSecurity;

    const checkSecurity = async () => {
        const config = await db.config.get('pin');
        if (!config) {
            document.getElementById('pin-title').innerText = 'Defina seu PIN de Acesso';
            setPinBtn.classList.remove('hidden');
            unlockBtn.classList.add('hidden');
        } else {
            document.getElementById('pin-title').innerText = 'Digite seu PIN';
            setPinBtn.classList.add('hidden');
            unlockBtn.classList.remove('hidden');
        }
    };

    setPinBtn.onclick = async () => {
        const pin = pinInput.value;
        if (pin.length < 4) { toast('O PIN deve ter pelo menos 4 dígitos.', 'warning'); return; }
        const value = await hashPin(pin);
        await db.config.put({ key: 'pin', value });
        toast('PIN definido com sucesso!', 'success');
        checkSecurity();
    };

    unlockBtn.onclick = async () => {
        const pin = pinInput.value;
        const config = await db.config.get('pin');
        const ok = await verifyPin(pin, config);
        if (!ok) { toast('PIN incorreto!', 'error'); return; }
        // Migra PIN legado em claro para hash
        if (config && typeof config.value === 'string') {
            const value = await hashPin(pin);
            await db.config.put({ key: 'pin', value });
        }
        state.isLocked = false;
        lockScreen.classList.add('hidden');
        mainContent.classList.remove('hidden');
        pinInput.value = '';
        startInactivityTimer();
        try { await processRecurring(); } catch (err) { console.warn('Recorrencias falharam:', err); }
        renderView('dashboard');
    };

    window.lockApp = () => {
        state.isLocked = true;
        stopInactivityTimer();
        lockScreen.classList.remove('hidden');
        mainContent.classList.add('hidden');
        pinInput.value = '';
        setTimeout(() => pinInput.focus(), 50);
    };

    // Enter envia o PIN
    pinInput.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        (setPinBtn.classList.contains('hidden') ? unlockBtn : setPinBtn).click();
    });

    // Esqueci meu PIN → restaurar via backup JSON
    forgotPinBtn.onclick = async () => {
        const ok = await confirmDialog({
            title: 'Esqueci meu PIN',
            message: 'Você pode redefinir o PIN restaurando um arquivo de backup JSON. Seus dados atuais não serão apagados — o backup será mesclado e o PIN será removido para você cadastrar um novo. Continuar?',
            okText: 'Selecionar backup',
            cancelText: 'Cancelar'
        });
        if (!ok) return;
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'application/json,.json';
        input.onchange = async (ev) => {
            const file = ev.target.files[0];
            if (!file) return;
            try {
                const backup = JSON.parse(await file.text());
                if (!backup || !backup.data) { toast('Arquivo inválido.', 'error'); return; }
                await db.transaction('rw', [db.entradas, db.saidas, db.dividas, db.poupanca, db.metas, db.config], async () => {
                    for (const t of BACKUP_TABLES) {
                        const rows = Array.isArray(backup.data[t]) ? backup.data[t] : [];
                        const rowsNoId = rows.map(({ id, ...rest }) => rest);
                        if (rowsNoId.length) await db[t].bulkAdd(rowsNoId);
                    }
                    await db.config.delete('pin');
                });
                toast('Backup restaurado. Defina um novo PIN.', 'success');
                await checkSecurity();
            } catch (err) {
                console.error(err);
                toast('Erro ao restaurar: ' + err.message, 'error');
            }
        };
        input.click();
    };

    // --- Auto-lock por inatividade ---
    let inactivityTimer = null;
    const getAutoLockMs = async () => {
        const cfg = await db.config.get('autoLockMinutes');
        const m = cfg ? parseFloat(cfg.value) : 5;
        return (isNaN(m) || m <= 0) ? 0 : m * 60 * 1000;
    };
    const resetInactivityTimer = async () => {
        if (state.isLocked) return;
        clearTimeout(inactivityTimer);
        const ms = await getAutoLockMs();
        if (!ms) return;
        inactivityTimer = setTimeout(() => { if (!state.isLocked) { toast('Bloqueado por inatividade.', 'info'); window.lockApp(); } }, ms);
    };
    const startInactivityTimer = () => {
        resetInactivityTimer();
        ['click', 'keydown', 'touchstart', 'pointermove'].forEach(ev =>
            document.addEventListener(ev, resetInactivityTimer, { passive: true })
        );
    };
    const stopInactivityTimer = () => { clearTimeout(inactivityTimer); inactivityTimer = null; };

    // Roteamento Simples
    window.renderView = async (view) => {
        state.currentView = view;
        const content = document.getElementById('view-content');
        content.innerHTML = '<div class="flex justify-center p-10"><div class="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div></div>';

        // Atualizar menu ativo
        document.querySelectorAll('nav button').forEach(btn => {
            btn.classList.remove('text-blue-600', 'border-b-2', 'border-blue-600');
            if (btn.dataset.view === view) {
                btn.classList.add('text-blue-600', 'border-b-2', 'border-blue-600');
            }
        });

        switch (view) {
            case 'dashboard': await renderDashboard(content); break;
            case 'entradas': await renderEntradas(content); break;
            case 'saidas': await renderSaidas(content); break;
            case 'dividas': await renderDividas(content); break;
            case 'poupanca': await renderPoupanca(content); break;
            case 'metas': await renderMetas(content); break;
            case 'configuracoes': await renderConfiguracoes(content); break;
        }
    };

    // --- Módulo 1: Dashboard ---
    async function renderDashboard(container) {
        const [entradas, saidas, poupanca, dividas, metas, reservaCfg] = await Promise.all([
            db.entradas.toArray(), db.saidas.toArray(), db.poupanca.toArray(),
            db.dividas.toArray(), db.metas.toArray(), db.config.get('metaReserva')
        ]);
        const metaReserva = reservaCfg ? parseFloat(reservaCfg.value) : 10000;
        const monthOf = (d) => (d || '').slice(0, 7);
        const currentMonth = new Date().toISOString().slice(0, 7);
        const sum = (arr) => arr.reduce((a, b) => a + parseFloat(b.valor || 0), 0);
        const fmt = (n) => n.toLocaleString('pt-BR', { minimumFractionDigits: 2 });

        const entradasMes = entradas.filter(i => monthOf(i.data) === currentMonth);
        const saidasMes = saidas.filter(i => monthOf(i.data) === currentMonth);
        const poupancaMes = poupanca.filter(i => monthOf(i.data) === currentMonth);
        const totalEntradasMes = sum(entradasMes);
        const totalSaidasMes = sum(saidasMes);
        const saldoMes = totalEntradasMes - totalSaidasMes;
        const totalPoupancaMes = sum(poupancaMes);

        const reservaTotal = sum(poupanca.filter(p => p.tipo === 'reserva'));
        const investimentoTotal = sum(poupanca.filter(p => p.tipo === 'investimento'));
        const dividaTotal = dividas.reduce((a, b) => a + parseFloat(b.saldoDevedor || 0), 0);
        const patrimonio = reservaTotal + investimentoTotal - dividaTotal;

        const fixaMes = sum(saidasMes.filter(s => s.tipo === 'fixa'));
        const variavelMes = sum(saidasMes.filter(s => s.tipo === 'variavel'));
        const pendentesMes = saidasMes.filter(s => s.status === 'pendente');
        const totalPendentesMes = sum(pendentesMes);

        // Agrega saidas do mes por categoria (Top 5 + "Outras")
        const catMap = new Map();
        for (const s of saidasMes) {
            const k = s.categoria || 'Outros';
            catMap.set(k, (catMap.get(k) || 0) + parseFloat(s.valor || 0));
        }
        const catRanking = Array.from(catMap.entries())
            .map(([nome, total]) => ({ nome, total }))
            .sort((a, b) => b.total - a.total);
        const top5 = catRanking.slice(0, 5);
        const restoTotal = catRanking.slice(5).reduce((a, b) => a + b.total, 0);
        const catChartLabels = top5.map(c => c.nome).concat(restoTotal > 0 ? ['Outras'] : []);
        const catChartData = top5.map(c => c.total).concat(restoTotal > 0 ? [restoTotal] : []);
        const catTotal = catChartData.reduce((a, b) => a + b, 0);
        const catPalette = ['#dc2626', '#ea580c', '#d97706', '#7c3aed', '#0891b2', '#6b7280'];

        const today = new Date(); today.setHours(0, 0, 0, 0);
        const venceEm = (v) => { if (!v) return null; const [y, m, d] = v.split('-').map(Number); return Math.round((new Date(y, m - 1, d) - today) / 86400000); };
        const dividasUrgentes = dividas.filter(d => { const di = venceEm(d.vencimento); return parseFloat(d.saldoDevedor || 0) > 0 && di !== null && di <= 7; });

        const progressoReserva = metaReserva > 0 ? Math.min((reservaTotal / metaReserva) * 100, 100) : 0;
        const metasAtivas = metas
            .filter(m => parseFloat(m.valorGuardado || 0) < parseFloat(m.valorAlvo || 0))
            .map(m => ({ ...m, pct: parseFloat(m.valorAlvo) > 0 ? (parseFloat(m.valorGuardado || 0) / parseFloat(m.valorAlvo)) * 100 : 0 }))
            .sort((a, b) => b.pct - a.pct).slice(0, 3);

        const labels6 = [], entradas6 = [], saidas6 = [];
        let mm = currentMonth;
        for (let i = 0; i < 6; i++) {
            labels6.unshift(formatMonthLabel(mm));
            entradas6.unshift(sum(entradas.filter(it => monthOf(it.data) === mm)));
            saidas6.unshift(sum(saidas.filter(it => monthOf(it.data) === mm)));
            mm = getPrevMonth(mm);
        }

        const hora = new Date().getHours();
        const saudacao = hora < 12 ? 'Bom dia' : (hora < 18 ? 'Boa tarde' : 'Boa noite');
        const dataHoje = new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
        const monthLabel = formatMonthLabel(currentMonth);

        container.innerHTML = `
            <div class="mb-4">
                <h2 class="text-2xl font-bold text-gray-800">${saudacao}! 👋</h2>
                <p class="text-sm text-gray-500 capitalize">${dataHoje}</p>
            </div>

            <div class="bg-gradient-to-br from-blue-600 to-blue-800 text-white p-5 rounded-xl shadow-lg mb-4">
                <div class="flex justify-between items-start flex-wrap gap-3">
                    <div>
                        <p class="text-xs uppercase tracking-wider opacity-80">Patrimônio Líquido</p>
                        <p class="text-3xl font-bold mt-1">R$ ${fmt(patrimonio)}</p>
                        <p class="text-xs opacity-80 mt-2">R$ ${fmt(reservaTotal + investimentoTotal)} em poupança · R$ ${fmt(dividaTotal)} em dívidas</p>
                    </div>
                    <div class="text-right">
                        <p class="text-xs opacity-80">Saldo de ${monthLabel}</p>
                        <p class="text-xl font-bold ${saldoMes >= 0 ? 'text-green-300' : 'text-red-300'}">${saldoMes >= 0 ? '+' : ''} R$ ${fmt(saldoMes)}</p>
                    </div>
                </div>
            </div>

            <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                <div class="bg-white p-3 rounded-lg shadow border-l-4 border-green-500">
                    <p class="text-xs text-gray-500">Entradas — ${monthLabel}</p>
                    <p class="text-lg font-bold text-green-600">R$ ${fmt(totalEntradasMes)}</p>
                </div>
                <div class="bg-white p-3 rounded-lg shadow border-l-4 border-red-500">
                    <p class="text-xs text-gray-500">Saídas — ${monthLabel}</p>
                    <p class="text-lg font-bold text-red-600">R$ ${fmt(totalSaidasMes)}</p>
                    ${totalPendentesMes > 0 ? `<p class="text-xs text-yellow-600 mt-1">⚠ R$ ${fmt(totalPendentesMes)} pendentes</p>` : ''}
                </div>
                <div class="bg-white p-3 rounded-lg shadow border-l-4 ${saldoMes >= 0 ? 'border-blue-500' : 'border-orange-500'}">
                    <p class="text-xs text-gray-500">Saldo do mês</p>
                    <p class="text-lg font-bold ${saldoMes >= 0 ? 'text-blue-600' : 'text-orange-600'}">R$ ${fmt(saldoMes)}</p>
                </div>
                <div class="bg-white p-3 rounded-lg shadow border-l-4 border-purple-500">
                    <p class="text-xs text-gray-500">Aportes — ${monthLabel}</p>
                    <p class="text-lg font-bold text-purple-600">R$ ${fmt(totalPoupancaMes)}</p>
                </div>
            </div>

            <div class="bg-white p-4 rounded-lg shadow mb-4">
                <h3 class="font-bold mb-3 text-gray-700">Evolução dos últimos 6 meses</h3>
                <canvas id="mainChart" height="100"></canvas>
            </div>

            <div class="bg-white p-4 rounded-lg shadow mb-4">
                <div class="flex justify-between items-center mb-3">
                    <h3 class="font-bold text-gray-700">Gastos por categoria — ${monthLabel}</h3>
                    ${catTotal > 0 ? `<span class="text-xs text-gray-500">Total R$ ${fmt(catTotal)}</span>` : ''}
                </div>
                ${catTotal === 0 ? `<p class="text-sm text-gray-400 text-center py-6">Sem saídas categorizadas neste mês</p>` : `
                    <div class="grid grid-cols-1 md:grid-cols-2 gap-4 items-center">
                        <div class="relative mx-auto" style="height:200px;max-width:240px"><canvas id="categoriaChart"></canvas></div>
                        <div class="space-y-2">
                            ${top5.map((c, idx) => {
                                const pct = catTotal > 0 ? (c.total / catTotal) * 100 : 0;
                                return `
                                    <div>
                                        <div class="flex justify-between text-xs mb-1">
                                            <span class="font-medium flex items-center gap-2"><span class="inline-block w-3 h-3 rounded" style="background:${catPalette[idx]}"></span>${escapeHtml(c.nome)}</span>
                                            <span class="text-gray-600">R$ ${fmt(c.total)} • ${pct.toFixed(1)}%</span>
                                        </div>
                                        <div class="w-full bg-gray-200 rounded-full h-2 overflow-hidden">
                                            <div class="h-2 rounded-full" style="width:${pct}%;background:${catPalette[idx]}"></div>
                                        </div>
                                    </div>`;
                            }).join('')}
                            ${restoTotal > 0 ? `<p class="text-xs text-gray-400">+ ${catRanking.length - 5} outra(s) categoria(s) — R$ ${fmt(restoTotal)}</p>` : ''}
                        </div>
                    </div>
                `}
            </div>

            <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                <div class="bg-white p-4 rounded-lg shadow">
                    <h3 class="font-bold mb-3 text-gray-700">Saídas de ${monthLabel} por tipo</h3>
                    ${(fixaMes + variavelMes) === 0 ? `<p class="text-sm text-gray-400 text-center py-8">Sem saídas neste mês</p>` : `<div class="relative" style="height:200px"><canvas id="donutChart"></canvas></div>`}
                </div>
                <div class="bg-white p-4 rounded-lg shadow">
                    <h3 class="font-bold mb-3 text-gray-700">Alertas</h3>
                    <div class="space-y-2 text-sm">
                        ${pendentesMes.length > 0 ? `<div class="flex items-start gap-2 p-2 bg-yellow-50 rounded border border-yellow-200"><span class="text-yellow-600">⚠</span><div><strong>${pendentesMes.length} conta(s) pendente(s)</strong> totalizando <strong>R$ ${fmt(totalPendentesMes)}</strong> em ${monthLabel}.</div></div>` : ''}
                        ${dividasUrgentes.length > 0 ? `<div class="flex items-start gap-2 p-2 bg-red-50 rounded border border-red-200"><span class="text-red-600">🔔</span><div><strong>${dividasUrgentes.length} dívida(s)</strong> vencendo nos próximos 7 dias.</div></div>` : ''}
                        ${saldoMes < 0 ? `<div class="flex items-start gap-2 p-2 bg-red-50 rounded border border-red-200"><span class="text-red-600">📉</span><div>Saldo do mês negativo em <strong>R$ ${fmt(Math.abs(saldoMes))}</strong>.</div></div>` : ''}
                        ${(pendentesMes.length === 0 && dividasUrgentes.length === 0 && saldoMes >= 0) ? `<div class="flex items-start gap-2 p-2 bg-green-50 rounded border border-green-200"><span class="text-green-600">✓</span><div>Nenhum alerta no momento. Tudo em ordem!</div></div>` : ''}
                    </div>
                </div>
            </div>

            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div class="bg-white p-4 rounded-lg shadow">
                    <div class="flex justify-between items-center mb-2">
                        <h3 class="font-bold text-gray-700">Reserva de emergência</h3>
                        <button onclick="setReservaMeta()" class="text-xs text-blue-600 hover:underline">Editar meta</button>
                    </div>
                    <div class="w-full bg-gray-200 rounded-full h-3 mb-2 overflow-hidden">
                        <div class="bg-gradient-to-r from-blue-500 to-blue-700 h-3 rounded-full transition-all" style="width: ${progressoReserva}%"></div>
                    </div>
                    <p class="text-sm text-gray-600">R$ ${fmt(reservaTotal)} de R$ ${fmt(metaReserva)} (${progressoReserva.toFixed(1)}%)</p>
                </div>
                <div class="bg-white p-4 rounded-lg shadow">
                    <h3 class="font-bold mb-3 text-gray-700">Top metas</h3>
                    ${metasAtivas.length === 0 ? `<p class="text-sm text-gray-400">Nenhuma meta ativa.</p>` : metasAtivas.map(m => `
                        <div class="mb-2 last:mb-0">
                            <div class="flex justify-between text-xs mb-1">
                                <span class="font-medium truncate pr-2">${m.nome}</span>
                                <span class="text-gray-500 flex-shrink-0">${m.pct.toFixed(1)}%</span>
                            </div>
                            <div class="w-full bg-gray-200 rounded-full h-2 overflow-hidden">
                                <div class="bg-purple-600 h-2 rounded-full transition-all" style="width: ${Math.min(m.pct, 100)}%"></div>
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;

        Object.values(state.charts || {}).forEach(c => c && c.destroy());
        state.charts = {};
        state.charts.main = new Chart(document.getElementById('mainChart').getContext('2d'), {
            type: 'line',
            data: { labels: labels6, datasets: [
                { label: 'Entradas', data: entradas6, borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.1)', tension: 0.3, fill: true },
                { label: 'Saídas', data: saidas6, borderColor: '#ef4444', backgroundColor: 'rgba(239,68,68,0.1)', tension: 0.3, fill: true }
            ]},
            options: { responsive: true, plugins: { legend: { position: 'bottom' } } }
        });
        if ((fixaMes + variavelMes) > 0) {
            state.charts.donut = new Chart(document.getElementById('donutChart').getContext('2d'), {
                type: 'doughnut',
                data: { labels: ['Fixa', 'Variável'], datasets: [{ data: [fixaMes, variavelMes], backgroundColor: ['#dc2626', '#fb923c'] }] },
                options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } }
            });
        }
        if (catTotal > 0) {
            const catEl = document.getElementById('categoriaChart');
            if (catEl) {
                state.charts.categoria = new Chart(catEl.getContext('2d'), {
                    type: 'doughnut',
                    data: { labels: catChartLabels, datasets: [{ data: catChartData, backgroundColor: catPalette.slice(0, catChartData.length) }] },
                    options: { responsive: true, maintainAspectRatio: false, cutout: '60%', plugins: { legend: { display: false } } }
                });
            }
        }
    }

    // --- Módulo 2: Entradas ---
    async function renderEntradas(container) {
        const filter = state.entradasFilter;
        const allItems = await db.entradas.orderBy('data').reverse().toArray();
        const monthOf = (d) => (d || '').slice(0, 7);
        let items = filter.mode === 'month'
            ? allItems.filter(i => monthOf(i.data) === filter.month)
            : allItems;
        if (filter.categoria && filter.categoria !== 'all') {
            items = items.filter(i => (i.categoria || 'Outros') === filter.categoria);
        }
        if (filter.q && filter.q.trim()) {
            const q = normSearch(filter.q);
            items = items.filter(i => normSearch(i.descricao).includes(q));
        }
        const cats = await getCategorias('entrada');

        const sum = (arr) => arr.reduce((a, b) => a + parseFloat(b.valor || 0), 0);
        const totalMes = sum(allItems.filter(i => monthOf(i.data) === filter.month));
        const prevMonth = getPrevMonth(filter.month);
        const totalPrev = sum(allItems.filter(i => monthOf(i.data) === prevMonth));
        const variacao = totalPrev > 0 ? ((totalMes - totalPrev) / totalPrev) * 100 : null;

        let m = filter.month, soma6 = 0;
        for (let i = 0; i < 6; i++) { soma6 += sum(allItems.filter(it => monthOf(it.data) === m)); m = getPrevMonth(m); }
        const media = soma6 / 6;

        const monthLabel = formatMonthLabel(filter.month);
        const totalLista = sum(items);
        const isMonth = filter.mode === 'month';
        const varArrow = variacao === null ? '' : (variacao >= 0 ? '↑' : '↓');
        const varColor = variacao === null ? 'text-gray-400' : (variacao >= 0 ? 'text-green-600' : 'text-red-600');
        const varText = variacao === null ? 'Sem dados' : `${Math.abs(variacao).toFixed(1)}%`;
        const fmt = (n) => n.toLocaleString('pt-BR', { minimumFractionDigits: 2 });

        container.innerHTML = `
            <h2 class="text-xl font-bold mb-3">Entradas</h2>

            <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                <div class="bg-white p-3 rounded-lg shadow border-l-4 border-green-500">
                    <p class="text-xs text-gray-500">Total — ${monthLabel}</p>
                    <p class="text-lg font-bold text-green-600">R$ ${fmt(totalMes)}</p>
                </div>
                <div class="bg-white p-3 rounded-lg shadow border-l-4 border-gray-300">
                    <p class="text-xs text-gray-500">Mês anterior</p>
                    <p class="text-lg font-bold text-gray-700">R$ ${fmt(totalPrev)}</p>
                </div>
                <div class="bg-white p-3 rounded-lg shadow border-l-4 border-blue-500">
                    <p class="text-xs text-gray-500">Variação</p>
                    <p class="text-lg font-bold ${varColor}">${varArrow} ${varText}</p>
                </div>
                <div class="bg-white p-3 rounded-lg shadow border-l-4 border-purple-500">
                    <p class="text-xs text-gray-500">Média (6 meses)</p>
                    <p class="text-lg font-bold text-purple-600">R$ ${fmt(media)}</p>
                </div>
            </div>

            <div class="flex flex-wrap gap-2 items-center justify-between bg-white p-3 rounded-lg shadow mb-4">
                <div class="flex items-center gap-2 flex-wrap">
                    <button onclick="changeEntradasMonth(-1)" ${isMonth ? '' : 'disabled'} class="p-2 rounded hover:bg-gray-100 transition ${isMonth ? '' : 'opacity-40 cursor-not-allowed'}" title="Mês anterior">
                        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"></path></svg>
                    </button>
                    <input type="month" value="${filter.month}" onchange="setEntradasMonth(this.value)" ${isMonth ? '' : 'disabled'} class="border rounded p-2 text-sm ${isMonth ? '' : 'opacity-40'}">
                    <button onclick="changeEntradasMonth(1)" ${isMonth ? '' : 'disabled'} class="p-2 rounded hover:bg-gray-100 transition ${isMonth ? '' : 'opacity-40 cursor-not-allowed'}" title="Próximo mês">
                        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"></path></svg>
                    </button>
                    <button onclick="toggleEntradasMode()" class="ml-1 px-3 py-2 rounded text-sm font-medium transition ${isMonth ? 'bg-gray-100 text-gray-700 hover:bg-gray-200' : 'bg-blue-600 text-white hover:bg-blue-700'}">
                        ${isMonth ? 'Ver todos' : 'Ver por mês'}
                    </button>
                </div>
                <button onclick="showModal('entrada')" class="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 transition inline-flex items-center gap-2">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path></svg>
                    Nova Entrada
                </button>
            </div>

            <div class="bg-white p-3 rounded-lg shadow mb-4 flex flex-wrap gap-2 items-center">
                <div class="flex-1 min-w-0">
                    <input type="search" id="entradas-search" value="${escapeHtml(filter.q)}" placeholder="Buscar por descricao..." class="w-full p-2 border-2 border-gray-200 rounded-lg focus:border-blue-500 outline-none text-sm" oninput="onSearchInput('entradas', this.value)">
                </div>
                <select onchange="setEntradasCategoria(this.value)" class="p-2 border-2 border-gray-200 rounded-lg focus:border-blue-500 outline-none text-sm">
                    <option value="all" ${filter.categoria === 'all' ? 'selected' : ''}>Todas as categorias</option>
                    ${cats.map(c => `<option value="${escapeHtml(c.nome)}" ${filter.categoria === c.nome ? 'selected' : ''}>${escapeHtml(c.nome)}</option>`).join('')}
                </select>
            </div>

            ${items.length === 0 ? `
                <div class="bg-white rounded-lg shadow p-10 text-center">
                    <div class="bg-green-100 w-20 h-20 rounded-full flex items-center justify-center mx-auto mb-4">
                        <svg class="w-10 h-10 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1"></path></svg>
                    </div>
                    <h3 class="font-bold text-gray-700 mb-1">${(filter.q || filter.categoria !== 'all') ? 'Nenhum resultado para os filtros' : (isMonth ? `Nenhuma entrada em ${monthLabel}` : 'Nenhuma entrada registrada')}</h3>
                    <p class="text-sm text-gray-500 mb-4">${(filter.q || filter.categoria !== 'all') ? 'Ajuste a busca ou os filtros.' : 'Adicione uma nova entrada para começar a acompanhar.'}</p>
                    <button onclick="showModal('entrada')" class="bg-blue-600 text-white px-5 py-2 rounded hover:bg-blue-700 transition">+ Nova Entrada</button>
                </div>
            ` : `
                ${!isMonth ? `
                    <div class="bg-green-50 border border-green-200 rounded-lg p-3 mb-3 flex justify-between items-center">
                        <span class="text-sm text-gray-700">${items.length} registro(s) • Total geral</span>
                        <span class="font-bold text-green-700">R$ ${fmt(totalLista)}</span>
                    </div>
                ` : ''}

                <div class="bg-white rounded-lg shadow overflow-hidden hidden md:block">
                    <table class="w-full text-left">
                        <thead class="bg-gray-50 text-xs uppercase text-gray-600">
                            <tr>
                                <th class="p-3">Data</th>
                                <th class="p-3">Descrição</th>
                                <th class="p-3">Categoria</th>
                                <th class="p-3">Valor</th>
                                <th class="p-3 text-right">Ações</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${items.map(item => `
                                <tr class="border-t hover:bg-gray-50 transition">
                                    <td class="p-3 text-sm text-gray-600">${formatDateBR(item.data)}</td>
                                    <td class="p-3">${escapeHtml(item.descricao)} ${item.recorrente ? '<span title="Recorrente mensal" class="text-xs text-blue-600 ml-1">↻</span>' : ''}</td>
                                    <td class="p-3"><span class="text-xs bg-gray-100 px-2 py-1 rounded">${escapeHtml(item.categoria || 'Outros')}</span></td>
                                    <td class="p-3 text-green-600 font-bold">R$ ${fmt(parseFloat(item.valor))}</td>
                                    <td class="p-3 text-right whitespace-nowrap">
                                        <button onclick="editItem('entradas', ${item.id})" class="text-blue-600 mr-1 p-2 rounded hover:bg-blue-50 transition" title="Editar"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"></path></svg></button>
                                        <button onclick="deleteItem('entradas', ${item.id})" class="text-red-600 p-2 rounded hover:bg-red-50 transition" title="Excluir"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg></button>
                                    </td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>

                <div class="space-y-2 md:hidden">
                    ${items.map(item => `
                        <div class="bg-white rounded-lg shadow p-3 border-l-4 border-green-500 flex justify-between items-center">
                            <div class="min-w-0 flex-1">
                                <p class="font-medium truncate">${escapeHtml(item.descricao)} ${item.recorrente ? '<span title="Recorrente mensal" class="text-xs text-blue-600">↻</span>' : ''}</p>
                                <div class="flex items-center gap-2 mt-1">
                                    <span class="text-xs text-gray-500">${formatDateBR(item.data)}</span>
                                    <span class="text-xs bg-gray-100 px-2 py-0.5 rounded">${escapeHtml(item.categoria || 'Outros')}</span>
                                </div>
                            </div>
                            <div class="text-right ml-3 flex-shrink-0">
                                <p class="font-bold text-green-600 mb-1">R$ ${fmt(parseFloat(item.valor))}</p>
                                <div class="flex justify-end gap-1">
                                    <button onclick="editItem('entradas', ${item.id})" class="text-blue-600 p-1.5 rounded hover:bg-blue-50 transition" title="Editar"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"></path></svg></button>
                                    <button onclick="deleteItem('entradas', ${item.id})" class="text-red-600 p-1.5 rounded hover:bg-red-50 transition" title="Excluir"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg></button>
                                </div>
                            </div>
                        </div>
                    `).join('')}
                </div>
            `}
        `;
        // Mantem foco no input apos re-render
        const searchEl = document.getElementById('entradas-search');
        if (searchEl && filter.q) {
            const len = searchEl.value.length;
            searchEl.focus();
            try { searchEl.setSelectionRange(len, len); } catch (_) {}
        }
    }

    // --- Módulo 3: Saídas ---
    async function renderSaidas(container) {
        const filter = state.saidasFilter;
        const allItems = await db.saidas.orderBy('data').reverse().toArray();
        const monthOf = (d) => (d || '').slice(0, 7);
        let items = filter.mode === 'month'
            ? allItems.filter(i => monthOf(i.data) === filter.month)
            : allItems;
        if (filter.status !== 'all') items = items.filter(i => i.status === filter.status);
        if (filter.tipo !== 'all') items = items.filter(i => i.tipo === filter.tipo);
        if (filter.categoria && filter.categoria !== 'all') {
            items = items.filter(i => (i.categoria || 'Outros') === filter.categoria);
        }
        if (filter.q && filter.q.trim()) {
            const q = normSearch(filter.q);
            items = items.filter(i => normSearch(i.descricao).includes(q));
        }
        const cats = await getCategorias('saida');

        const sum = (arr) => arr.reduce((a, b) => a + parseFloat(b.valor || 0), 0);
        const mesArr = allItems.filter(i => monthOf(i.data) === filter.month);
        const totalMes = sum(mesArr);
        const prevMonth = getPrevMonth(filter.month);
        const totalPrev = sum(allItems.filter(i => monthOf(i.data) === prevMonth));
        const variacao = totalPrev > 0 ? ((totalMes - totalPrev) / totalPrev) * 100 : null;
        let m = filter.month, soma6 = 0;
        for (let i = 0; i < 6; i++) { soma6 += sum(allItems.filter(it => monthOf(it.data) === m)); m = getPrevMonth(m); }
        const media = soma6 / 6;
        const pagoMes = sum(mesArr.filter(i => i.status === 'pago'));
        const pendMes = sum(mesArr.filter(i => i.status === 'pendente'));

        const monthLabel = formatMonthLabel(filter.month);
        const totalLista = sum(items);
        const isMonth = filter.mode === 'month';
        const varArrow = variacao === null ? '' : (variacao >= 0 ? '↑' : '↓');
        const varColor = variacao === null ? 'text-gray-400' : (variacao >= 0 ? 'text-red-600' : 'text-green-600');
        const varText = variacao === null ? 'Sem dados' : `${Math.abs(variacao).toFixed(1)}%`;
        const fmt = (n) => n.toLocaleString('pt-BR', { minimumFractionDigits: 2 });
        const chipBase = 'px-3 py-1 rounded-full text-xs font-medium transition';
        const chipOff = 'bg-gray-100 text-gray-700 hover:bg-gray-200';

        container.innerHTML = `
            <h2 class="text-xl font-bold mb-3">Saídas</h2>

            <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                <div class="bg-white p-3 rounded-lg shadow border-l-4 border-red-500">
                    <p class="text-xs text-gray-500">Total — ${monthLabel}</p>
                    <p class="text-lg font-bold text-red-600">R$ ${fmt(totalMes)}</p>
                    <p class="text-xs text-gray-400 mt-1">Pago R$ ${fmt(pagoMes)} • Pend. R$ ${fmt(pendMes)}</p>
                </div>
                <div class="bg-white p-3 rounded-lg shadow border-l-4 border-gray-300">
                    <p class="text-xs text-gray-500">Mês anterior</p>
                    <p class="text-lg font-bold text-gray-700">R$ ${fmt(totalPrev)}</p>
                </div>
                <div class="bg-white p-3 rounded-lg shadow border-l-4 border-blue-500">
                    <p class="text-xs text-gray-500">Variação</p>
                    <p class="text-lg font-bold ${varColor}">${varArrow} ${varText}</p>
                </div>
                <div class="bg-white p-3 rounded-lg shadow border-l-4 border-purple-500">
                    <p class="text-xs text-gray-500">Média (6 meses)</p>
                    <p class="text-lg font-bold text-purple-600">R$ ${fmt(media)}</p>
                </div>
            </div>

            <div class="flex flex-wrap gap-2 items-center justify-between bg-white p-3 rounded-lg shadow mb-3">
                <div class="flex items-center gap-2 flex-wrap">
                    <button onclick="changeSaidasMonth(-1)" ${isMonth ? '' : 'disabled'} class="p-2 rounded hover:bg-gray-100 transition ${isMonth ? '' : 'opacity-40 cursor-not-allowed'}" title="Mês anterior">
                        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"></path></svg>
                    </button>
                    <input type="month" value="${filter.month}" onchange="setSaidasMonth(this.value)" ${isMonth ? '' : 'disabled'} class="border rounded p-2 text-sm ${isMonth ? '' : 'opacity-40'}">
                    <button onclick="changeSaidasMonth(1)" ${isMonth ? '' : 'disabled'} class="p-2 rounded hover:bg-gray-100 transition ${isMonth ? '' : 'opacity-40 cursor-not-allowed'}" title="Próximo mês">
                        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"></path></svg>
                    </button>
                    <button onclick="toggleSaidasMode()" class="ml-1 px-3 py-2 rounded text-sm font-medium transition ${isMonth ? 'bg-gray-100 text-gray-700 hover:bg-gray-200' : 'bg-red-600 text-white hover:bg-red-700'}">
                        ${isMonth ? 'Ver todas' : 'Ver por mês'}
                    </button>
                </div>
                <button onclick="showModal('saida')" class="bg-red-600 text-white px-4 py-2 rounded hover:bg-red-700 transition inline-flex items-center gap-2">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path></svg>
                    Nova Saída
                </button>
            </div>

            <div class="bg-white p-3 rounded-lg shadow mb-3 flex flex-wrap gap-2 items-center">
                <span class="text-xs text-gray-500 mr-1">Status:</span>
                <button onclick="setSaidasStatus('all')" class="${chipBase} ${filter.status === 'all' ? 'bg-red-600 text-white' : chipOff}">Todas</button>
                <button onclick="setSaidasStatus('pago')" class="${chipBase} ${filter.status === 'pago' ? 'bg-green-600 text-white' : chipOff}">Pagas</button>
                <button onclick="setSaidasStatus('pendente')" class="${chipBase} ${filter.status === 'pendente' ? 'bg-yellow-500 text-white' : chipOff}">Pendentes</button>
                <span class="text-xs text-gray-500 ml-3 mr-1">Tipo:</span>
                <button onclick="setSaidasTipo('all')" class="${chipBase} ${filter.tipo === 'all' ? 'bg-red-600 text-white' : chipOff}">Todos</button>
                <button onclick="setSaidasTipo('fixa')" class="${chipBase} ${filter.tipo === 'fixa' ? 'bg-red-600 text-white' : chipOff}">Fixa</button>
                <button onclick="setSaidasTipo('variavel')" class="${chipBase} ${filter.tipo === 'variavel' ? 'bg-red-600 text-white' : chipOff}">Variável</button>
            </div>

            <div class="bg-white p-3 rounded-lg shadow mb-4 flex flex-wrap gap-2 items-center">
                <div class="flex-1 min-w-0">
                    <input type="search" id="saidas-search" value="${escapeHtml(filter.q)}" placeholder="Buscar por descricao..." class="w-full p-2 border-2 border-gray-200 rounded-lg focus:border-red-500 outline-none text-sm" oninput="onSearchInput('saidas', this.value)">
                </div>
                <select onchange="setSaidasCategoria(this.value)" class="p-2 border-2 border-gray-200 rounded-lg focus:border-red-500 outline-none text-sm">
                    <option value="all" ${filter.categoria === 'all' ? 'selected' : ''}>Todas as categorias</option>
                    ${cats.map(c => `<option value="${escapeHtml(c.nome)}" ${filter.categoria === c.nome ? 'selected' : ''}>${escapeHtml(c.nome)}</option>`).join('')}
                </select>
            </div>

            ${items.length === 0 ? `
                <div class="bg-white rounded-lg shadow p-10 text-center">
                    <div class="bg-red-100 w-20 h-20 rounded-full flex items-center justify-center mx-auto mb-4">
                        <svg class="w-10 h-10 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 12H4"></path></svg>
                    </div>
                    <h3 class="font-bold text-gray-700 mb-1">Nenhuma saída encontrada</h3>
                    <p class="text-sm text-gray-500 mb-4">Ajuste os filtros ou registre uma nova saída.</p>
                    <button onclick="showModal('saida')" class="bg-red-600 text-white px-5 py-2 rounded hover:bg-red-700 transition">+ Nova Saída</button>
                </div>
            ` : `
                <div class="bg-red-50 border border-red-200 rounded-lg p-3 mb-3 flex justify-between items-center">
                    <span class="text-sm text-gray-700">${items.length} registro(s) • Total filtrado</span>
                    <span class="font-bold text-red-700">R$ ${fmt(totalLista)}</span>
                </div>

                <div class="bg-white rounded-lg shadow overflow-hidden hidden md:block">
                    <table class="w-full text-left">
                        <thead class="bg-gray-50 text-xs uppercase text-gray-600">
                            <tr>
                                <th class="p-3">Status</th><th class="p-3">Data</th><th class="p-3">Descrição</th>
                                <th class="p-3">Categoria</th><th class="p-3">Tipo</th><th class="p-3">Valor</th><th class="p-3 text-right">Ações</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${items.map(item => `
                                <tr class="border-t hover:bg-gray-50 transition">
                                    <td class="p-3"><button onclick="toggleStatus('saidas', ${item.id}, '${item.status}')" class="px-2 py-1 rounded text-xs font-bold transition ${item.status === 'pago' ? 'bg-green-100 text-green-700 hover:bg-green-200' : 'bg-yellow-100 text-yellow-700 hover:bg-yellow-200'}">${item.status.toUpperCase()}</button></td>
                                    <td class="p-3 text-sm text-gray-600">${formatDateBR(item.data)}</td>
                                    <td class="p-3">${escapeHtml(item.descricao)} ${item.recorrente ? '<span title="Recorrente mensal" class="text-xs text-blue-600 ml-1">↻</span>' : ''}</td>
                                    <td class="p-3"><span class="text-xs bg-gray-100 px-2 py-1 rounded">${escapeHtml(item.categoria || 'Outros')}</span></td>
                                    <td class="p-3"><span class="text-xs bg-gray-100 px-2 py-1 rounded capitalize">${item.tipo}</span></td>
                                    <td class="p-3 text-red-600 font-bold">R$ ${fmt(parseFloat(item.valor))}</td>
                                    <td class="p-3 text-right whitespace-nowrap">
                                        <button onclick="editItem('saidas', ${item.id})" class="text-blue-600 mr-1 p-2 rounded hover:bg-blue-50 transition" title="Editar"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"></path></svg></button>
                                        <button onclick="deleteItem('saidas', ${item.id})" class="text-red-600 p-2 rounded hover:bg-red-50 transition" title="Excluir"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg></button>
                                    </td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>

                <div class="space-y-2 md:hidden">
                    ${items.map(item => `
                        <div class="bg-white rounded-lg shadow p-3 border-l-4 border-red-500">
                            <div class="flex justify-between items-start gap-2">
                                <div class="min-w-0 flex-1">
                                    <p class="font-medium truncate">${escapeHtml(item.descricao)} ${item.recorrente ? '<span title="Recorrente mensal" class="text-xs text-blue-600">↻</span>' : ''}</p>
                                    <div class="flex items-center gap-2 mt-1 flex-wrap">
                                        <span class="text-xs text-gray-500">${formatDateBR(item.data)}</span>
                                        <span class="text-xs bg-gray-100 px-2 py-0.5 rounded">${escapeHtml(item.categoria || 'Outros')}</span>
                                        <span class="text-xs bg-gray-100 px-2 py-0.5 rounded capitalize">${item.tipo}</span>
                                        <button onclick="toggleStatus('saidas', ${item.id}, '${item.status}')" class="px-2 py-0.5 rounded text-xs font-bold ${item.status === 'pago' ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'}">${item.status.toUpperCase()}</button>
                                    </div>
                                </div>
                                <div class="text-right flex-shrink-0">
                                    <p class="font-bold text-red-600">R$ ${fmt(parseFloat(item.valor))}</p>
                                    <div class="flex justify-end gap-1 mt-1">
                                        <button onclick="editItem('saidas', ${item.id})" class="text-blue-600 p-1.5 rounded hover:bg-blue-50 transition" title="Editar"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"></path></svg></button>
                                        <button onclick="deleteItem('saidas', ${item.id})" class="text-red-600 p-1.5 rounded hover:bg-red-50 transition" title="Excluir"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg></button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    `).join('')}
                </div>
            `}
        `;
        const searchEl = document.getElementById('saidas-search');
        if (searchEl && filter.q) {
            const len = searchEl.value.length;
            searchEl.focus();
            try { searchEl.setSelectionRange(len, len); } catch (_) {}
        }
    }

    // --- Módulo 4: Dívidas ---
    async function renderDividas(container) {
        const filter = state.dividasFilter;
        const all = await db.dividas.toArray();
        const isAtiva = (it) => parseFloat(it.saldoDevedor || 0) > 0;
        let items = all;
        if (filter.status === 'ativas') items = all.filter(isAtiva);
        else if (filter.status === 'quitadas') items = all.filter(it => !isAtiva(it));
        if (filter.q && filter.q.trim()) {
            const q = normSearch(filter.q);
            items = items.filter(i => normSearch(i.nome).includes(q));
        }
        if (filter.sort === 'vencimento') items.sort((a, b) => (a.vencimento || '').localeCompare(b.vencimento || ''));
        else items.sort((a, b) => parseFloat(b.saldoDevedor || 0) - parseFloat(a.saldoDevedor || 0));

        const fmt = (n) => n.toLocaleString('pt-BR', { minimumFractionDigits: 2 });
        const totalOriginal = all.reduce((a, b) => a + parseFloat(b.valorOriginal || 0), 0);
        const totalDevedor = all.reduce((a, b) => a + parseFloat(b.saldoDevedor || 0), 0);
        const amortizado = totalOriginal - totalDevedor;
        const progressoGeral = totalOriginal > 0 ? (amortizado / totalOriginal) * 100 : 0;
        const ativasCount = all.filter(isAtiva).length;
        const chipBase = 'px-3 py-1 rounded-full text-xs font-medium transition';
        const chipOff = 'bg-gray-100 text-gray-700 hover:bg-gray-200';

        const today = new Date(); today.setHours(0, 0, 0, 0);
        const venceEm = (venc) => {
            if (!venc) return null;
            const [y, m, d] = venc.split('-').map(Number);
            return Math.round((new Date(y, m - 1, d) - today) / 86400000);
        };

        container.innerHTML = `
            <h2 class="text-xl font-bold mb-3">Dívidas</h2>

            <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                <div class="bg-white p-3 rounded-lg shadow border-l-4 border-red-500">
                    <p class="text-xs text-gray-500">Saldo devedor</p>
                    <p class="text-lg font-bold text-red-600">R$ ${fmt(totalDevedor)}</p>
                </div>
                <div class="bg-white p-3 rounded-lg shadow border-l-4 border-gray-300">
                    <p class="text-xs text-gray-500">Valor original</p>
                    <p class="text-lg font-bold text-gray-700">R$ ${fmt(totalOriginal)}</p>
                </div>
                <div class="bg-white p-3 rounded-lg shadow border-l-4 border-green-500">
                    <p class="text-xs text-gray-500">Já pago</p>
                    <p class="text-lg font-bold text-green-600">R$ ${fmt(amortizado)}</p>
                </div>
                <div class="bg-white p-3 rounded-lg shadow border-l-4 border-orange-500">
                    <p class="text-xs text-gray-500">Dívidas ativas</p>
                    <p class="text-lg font-bold text-orange-600">${ativasCount} de ${all.length}</p>
                </div>
            </div>

            <div class="bg-white p-4 rounded-lg shadow mb-4">
                <div class="flex justify-between items-center mb-2">
                    <p class="text-sm font-bold">Progresso de amortização</p>
                    <span class="text-sm text-gray-600">${progressoGeral.toFixed(1)}%</span>
                </div>
                <div class="w-full bg-gray-200 rounded-full h-3 overflow-hidden">
                    <div class="bg-gradient-to-r from-green-500 to-orange-500 h-3 rounded-full transition-all" style="width: ${progressoGeral}%"></div>
                </div>
            </div>

            <div class="flex flex-wrap gap-2 items-center justify-between bg-white p-3 rounded-lg shadow mb-3">
                <div class="flex items-center gap-2 flex-wrap">
                    <span class="text-xs text-gray-500 mr-1">Status:</span>
                    <button onclick="setDividasStatus('ativas')" class="${chipBase} ${filter.status === 'ativas' ? 'bg-orange-600 text-white' : chipOff}">Ativas</button>
                    <button onclick="setDividasStatus('quitadas')" class="${chipBase} ${filter.status === 'quitadas' ? 'bg-green-600 text-white' : chipOff}">Quitadas</button>
                    <button onclick="setDividasStatus('all')" class="${chipBase} ${filter.status === 'all' ? 'bg-gray-600 text-white' : chipOff}">Todas</button>
                    <span class="text-xs text-gray-500 ml-3 mr-1">Ordenar:</span>
                    <button onclick="setDividasSort('vencimento')" class="${chipBase} ${filter.sort === 'vencimento' ? 'bg-blue-600 text-white' : chipOff}">Vencimento</button>
                    <button onclick="setDividasSort('saldo')" class="${chipBase} ${filter.sort === 'saldo' ? 'bg-blue-600 text-white' : chipOff}">Maior saldo</button>
                </div>
                <button onclick="showModal('divida')" class="bg-orange-600 text-white px-4 py-2 rounded hover:bg-orange-700 transition inline-flex items-center gap-2">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path></svg>
                    Nova Dívida
                </button>
            </div>

            <div class="bg-white p-3 rounded-lg shadow mb-4">
                <input type="search" id="dividas-search" value="${escapeHtml(filter.q)}" placeholder="Buscar por nome..." class="w-full p-2 border-2 border-gray-200 rounded-lg focus:border-orange-500 outline-none text-sm" oninput="onSearchInput('dividas', this.value)">
            </div>

            ${items.length === 0 ? `
                <div class="bg-white rounded-lg shadow p-10 text-center">
                    <div class="bg-orange-100 w-20 h-20 rounded-full flex items-center justify-center mx-auto mb-4">
                        <svg class="w-10 h-10 text-orange-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                    </div>
                    <h3 class="font-bold text-gray-700 mb-1">${filter.status === 'ativas' ? 'Nenhuma dívida ativa 🎉' : 'Nenhuma dívida encontrada'}</h3>
                    <p class="text-sm text-gray-500 mb-4">${filter.status === 'ativas' ? 'Você está livre de dívidas no momento.' : 'Cadastre uma nova dívida para acompanhar.'}</p>
                    <button onclick="showModal('divida')" class="bg-orange-600 text-white px-5 py-2 rounded hover:bg-orange-700 transition">+ Nova Dívida</button>
                </div>
            ` : `
                <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
                    ${items.map(item => {
                        const orig = parseFloat(item.valorOriginal || 0);
                        const saldo = parseFloat(item.saldoDevedor || 0);
                        const pago = Math.max(orig - saldo, 0);
                        const pct = orig > 0 ? Math.min((pago / orig) * 100, 100) : 0;
                        const dias = venceEm(item.vencimento);
                        const quitada = saldo <= 0;
                        let badge = '';
                        if (quitada) badge = '<span class="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded font-bold">QUITADA</span>';
                        else if (dias !== null && dias < 0) badge = `<span class="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded font-bold">VENCIDA há ${Math.abs(dias)}d</span>`;
                        else if (dias !== null && dias <= 7) badge = `<span class="text-xs bg-yellow-100 text-yellow-700 px-2 py-0.5 rounded font-bold">Vence em ${dias}d</span>`;
                        else if (dias !== null) badge = `<span class="text-xs text-gray-500">Vence ${formatDateBR(item.vencimento)}</span>`;
                        const barColor = quitada ? 'bg-green-500' : (dias !== null && dias < 0 ? 'bg-red-500' : 'bg-orange-500');
                        return `
                            <div class="bg-white p-4 rounded-lg shadow border-l-4 ${quitada ? 'border-green-500' : 'border-orange-500'} hover:shadow-md transition">
                                <div class="flex justify-between items-start mb-2 gap-2">
                                    <h3 class="font-bold truncate">${item.nome}</h3>
                                    ${badge}
                                </div>
                                <div class="w-full bg-gray-200 rounded-full h-2 mb-2 overflow-hidden">
                                    <div class="${barColor} h-2 rounded-full transition-all" style="width: ${pct}%"></div>
                                </div>
                                <div class="grid grid-cols-3 gap-2 text-xs mb-3">
                                    <div><p class="text-gray-500">Original</p><p class="font-bold text-gray-700">R$ ${fmt(orig)}</p></div>
                                    <div><p class="text-gray-500">Pago</p><p class="font-bold text-green-600">R$ ${fmt(pago)}</p></div>
                                    <div><p class="text-gray-500">Saldo</p><p class="font-bold text-red-600">R$ ${fmt(saldo)}</p></div>
                                </div>
                                <div class="flex justify-end gap-1 border-t pt-2">
                                    <button onclick="editItem('dividas', ${item.id})" class="text-blue-600 p-2 rounded hover:bg-blue-50 transition" title="Editar"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"></path></svg></button>
                                    <button onclick="deleteItem('dividas', ${item.id})" class="text-red-600 p-2 rounded hover:bg-red-50 transition" title="Excluir"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg></button>
                                </div>
                            </div>
                        `;
                    }).join('')}
                </div>
            `}
        `;
        const searchEl = document.getElementById('dividas-search');
        if (searchEl && filter.q) {
            const len = searchEl.value.length;
            searchEl.focus();
            try { searchEl.setSelectionRange(len, len); } catch (_) {}
        }
    }

    // --- Módulo 5: Poupança ---
    async function renderPoupanca(container) {
        const filter = state.poupancaFilter;
        const all = await db.poupanca.orderBy('data').reverse().toArray();
        const monthOf = (d) => (d || '').slice(0, 7);
        let items = filter.mode === 'month' ? all.filter(i => monthOf(i.data) === filter.month) : all;
        if (filter.tipo !== 'all') items = items.filter(i => i.tipo === filter.tipo);

        const fmt = (n) => n.toLocaleString('pt-BR', { minimumFractionDigits: 2 });
        const sum = (arr) => arr.reduce((a, b) => a + parseFloat(b.valor || 0), 0);
        const totalReserva = sum(all.filter(i => i.tipo === 'reserva'));
        const totalInv = sum(all.filter(i => i.tipo === 'investimento'));
        const totalGeral = totalReserva + totalInv;
        const aportesMes = sum(all.filter(i => monthOf(i.data) === new Date().toISOString().slice(0, 7)));
        const totalLista = sum(items);
        const isMonth = filter.mode === 'month';
        const monthLabel = formatMonthLabel(filter.month);
        const chipBase = 'px-3 py-1 rounded-full text-xs font-medium transition';
        const chipOff = 'bg-gray-100 text-gray-700 hover:bg-gray-200';
        const tipoLabel = (t) => t === 'reserva' ? 'Reserva' : 'Investimento';
        const tipoColor = (t) => t === 'reserva' ? 'bg-blue-100 text-blue-700' : 'bg-indigo-100 text-indigo-700';

        container.innerHTML = `
            <h2 class="text-xl font-bold mb-3">Poupança e Investimentos</h2>

            <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                <div class="bg-white p-3 rounded-lg shadow border-l-4 border-blue-500">
                    <p class="text-xs text-gray-500">Reserva</p>
                    <p class="text-lg font-bold text-blue-600">R$ ${fmt(totalReserva)}</p>
                </div>
                <div class="bg-white p-3 rounded-lg shadow border-l-4 border-indigo-500">
                    <p class="text-xs text-gray-500">Investimentos</p>
                    <p class="text-lg font-bold text-indigo-600">R$ ${fmt(totalInv)}</p>
                </div>
                <div class="bg-white p-3 rounded-lg shadow border-l-4 border-green-500">
                    <p class="text-xs text-gray-500">Total acumulado</p>
                    <p class="text-lg font-bold text-green-600">R$ ${fmt(totalGeral)}</p>
                </div>
                <div class="bg-white p-3 rounded-lg shadow border-l-4 border-purple-500">
                    <p class="text-xs text-gray-500">Aportes do mês</p>
                    <p class="text-lg font-bold text-purple-600">R$ ${fmt(aportesMes)}</p>
                </div>
            </div>

            <div class="flex flex-wrap gap-2 items-center justify-between bg-white p-3 rounded-lg shadow mb-3">
                <div class="flex items-center gap-2 flex-wrap">
                    <button onclick="changePoupancaMonth(-1)" ${isMonth ? '' : 'disabled'} class="p-2 rounded hover:bg-gray-100 transition ${isMonth ? '' : 'opacity-40 cursor-not-allowed'}" title="Mês anterior">
                        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"></path></svg>
                    </button>
                    <input type="month" value="${filter.month}" onchange="setPoupancaMonth(this.value)" ${isMonth ? '' : 'disabled'} class="border rounded p-2 text-sm ${isMonth ? '' : 'opacity-40'}">
                    <button onclick="changePoupancaMonth(1)" ${isMonth ? '' : 'disabled'} class="p-2 rounded hover:bg-gray-100 transition ${isMonth ? '' : 'opacity-40 cursor-not-allowed'}" title="Próximo mês">
                        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"></path></svg>
                    </button>
                    <button onclick="togglePoupancaMode()" class="ml-1 px-3 py-2 rounded text-sm font-medium transition ${isMonth ? 'bg-gray-100 text-gray-700 hover:bg-gray-200' : 'bg-indigo-600 text-white hover:bg-indigo-700'}">
                        ${isMonth ? 'Ver todos' : 'Ver por mês'}
                    </button>
                </div>
                <button onclick="showModal('poupanca')" class="bg-indigo-600 text-white px-4 py-2 rounded hover:bg-indigo-700 transition inline-flex items-center gap-2">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path></svg>
                    Novo Aporte
                </button>
            </div>

            <div class="bg-white p-3 rounded-lg shadow mb-4 flex flex-wrap gap-2 items-center">
                <span class="text-xs text-gray-500 mr-1">Tipo:</span>
                <button onclick="setPoupancaTipo('all')" class="${chipBase} ${filter.tipo === 'all' ? 'bg-indigo-600 text-white' : chipOff}">Todos</button>
                <button onclick="setPoupancaTipo('reserva')" class="${chipBase} ${filter.tipo === 'reserva' ? 'bg-blue-600 text-white' : chipOff}">Reserva</button>
                <button onclick="setPoupancaTipo('investimento')" class="${chipBase} ${filter.tipo === 'investimento' ? 'bg-indigo-600 text-white' : chipOff}">Investimento</button>
            </div>

            ${items.length === 0 ? `
                <div class="bg-white rounded-lg shadow p-10 text-center">
                    <div class="bg-indigo-100 w-20 h-20 rounded-full flex items-center justify-center mx-auto mb-4">
                        <svg class="w-10 h-10 text-indigo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                    </div>
                    <h3 class="font-bold text-gray-700 mb-1">${isMonth ? `Nenhum aporte em ${monthLabel}` : 'Nenhum aporte registrado'}</h3>
                    <p class="text-sm text-gray-500 mb-4">Registre seu primeiro aporte e comece a acumular.</p>
                    <button onclick="showModal('poupanca')" class="bg-indigo-600 text-white px-5 py-2 rounded hover:bg-indigo-700 transition">+ Novo Aporte</button>
                </div>
            ` : `
                <div class="bg-indigo-50 border border-indigo-200 rounded-lg p-3 mb-3 flex justify-between items-center">
                    <span class="text-sm text-gray-700">${items.length} aporte(s) • Total filtrado</span>
                    <span class="font-bold text-indigo-700">R$ ${fmt(totalLista)}</span>
                </div>

                <div class="bg-white rounded-lg shadow overflow-hidden hidden md:block">
                    <table class="w-full text-left">
                        <thead class="bg-gray-50 text-xs uppercase text-gray-600">
                            <tr><th class="p-3">Data</th><th class="p-3">Tipo</th><th class="p-3">Valor</th><th class="p-3 text-right">Ações</th></tr>
                        </thead>
                        <tbody>
                            ${items.map(item => `
                                <tr class="border-t hover:bg-gray-50 transition">
                                    <td class="p-3 text-sm text-gray-600">${formatDateBR(item.data)}</td>
                                    <td class="p-3"><span class="text-xs px-2 py-1 rounded ${tipoColor(item.tipo)}">${tipoLabel(item.tipo)}</span></td>
                                    <td class="p-3 text-indigo-600 font-bold">R$ ${fmt(parseFloat(item.valor))}</td>
                                    <td class="p-3 text-right whitespace-nowrap">
                                        <button onclick="editItem('poupanca', ${item.id})" class="text-blue-600 mr-1 p-2 rounded hover:bg-blue-50 transition" title="Editar"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"></path></svg></button>
                                        <button onclick="deleteItem('poupanca', ${item.id})" class="text-red-600 p-2 rounded hover:bg-red-50 transition" title="Excluir"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg></button>
                                    </td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>

                <div class="space-y-2 md:hidden">
                    ${items.map(item => `
                        <div class="bg-white rounded-lg shadow p-3 border-l-4 ${item.tipo === 'reserva' ? 'border-blue-500' : 'border-indigo-500'} flex justify-between items-center">
                            <div class="min-w-0 flex-1">
                                <p class="font-medium"><span class="text-xs px-2 py-0.5 rounded mr-2 ${tipoColor(item.tipo)}">${tipoLabel(item.tipo)}</span></p>
                                <p class="text-xs text-gray-500 mt-1">${formatDateBR(item.data)}</p>
                            </div>
                            <div class="text-right ml-3 flex-shrink-0">
                                <p class="font-bold text-indigo-600 mb-1">R$ ${fmt(parseFloat(item.valor))}</p>
                                <div class="flex justify-end gap-1">
                                    <button onclick="editItem('poupanca', ${item.id})" class="text-blue-600 p-1.5 rounded hover:bg-blue-50 transition" title="Editar"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"></path></svg></button>
                                    <button onclick="deleteItem('poupanca', ${item.id})" class="text-red-600 p-1.5 rounded hover:bg-red-50 transition" title="Excluir"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg></button>
                                </div>
                            </div>
                        </div>
                    `).join('')}
                </div>
            `}
        `;
    }

    // --- Módulo 6: Metas ---
    async function renderMetas(container) {
        const filter = state.metasFilter;
        const all = await db.metas.toArray();
        const isConcluida = (it) => parseFloat(it.valorGuardado || 0) >= parseFloat(it.valorAlvo || 0);
        let items = all;
        if (filter.status === 'ativas') items = all.filter(it => !isConcluida(it));
        else if (filter.status === 'concluidas') items = all.filter(isConcluida);
        if (filter.q && filter.q.trim()) {
            const q = normSearch(filter.q);
            items = items.filter(i => normSearch(i.nome).includes(q));
        }

        const fmt = (n) => n.toLocaleString('pt-BR', { minimumFractionDigits: 2 });
        const totalAlvo = all.reduce((a, b) => a + parseFloat(b.valorAlvo || 0), 0);
        const totalGuardado = all.reduce((a, b) => a + parseFloat(b.valorGuardado || 0), 0);
        const progressoGeral = totalAlvo > 0 ? Math.min((totalGuardado / totalAlvo) * 100, 100) : 0;
        const concluidasCount = all.filter(isConcluida).length;
        const chipBase = 'px-3 py-1 rounded-full text-xs font-medium transition';
        const chipOff = 'bg-gray-100 text-gray-700 hover:bg-gray-200';

        const today = new Date(); today.setHours(0, 0, 0, 0);
        const diasAte = (dt) => {
            if (!dt) return null;
            const [y, m, d] = dt.split('-').map(Number);
            return Math.round((new Date(y, m - 1, d) - today) / 86400000);
        };

        container.innerHTML = `
            <h2 class="text-xl font-bold mb-3">Metas</h2>

            <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                <div class="bg-white p-3 rounded-lg shadow border-l-4 border-purple-500">
                    <p class="text-xs text-gray-500">Total guardado</p>
                    <p class="text-lg font-bold text-purple-600">R$ ${fmt(totalGuardado)}</p>
                </div>
                <div class="bg-white p-3 rounded-lg shadow border-l-4 border-gray-300">
                    <p class="text-xs text-gray-500">Total alvo</p>
                    <p class="text-lg font-bold text-gray-700">R$ ${fmt(totalAlvo)}</p>
                </div>
                <div class="bg-white p-3 rounded-lg shadow border-l-4 border-blue-500">
                    <p class="text-xs text-gray-500">Progresso geral</p>
                    <p class="text-lg font-bold text-blue-600">${progressoGeral.toFixed(1)}%</p>
                </div>
                <div class="bg-white p-3 rounded-lg shadow border-l-4 border-green-500">
                    <p class="text-xs text-gray-500">Concluídas</p>
                    <p class="text-lg font-bold text-green-600">${concluidasCount} de ${all.length}</p>
                </div>
            </div>

            <div class="bg-white p-4 rounded-lg shadow mb-4">
                <div class="flex justify-between items-center mb-2">
                    <p class="text-sm font-bold">Progresso geral das metas</p>
                    <span class="text-sm text-gray-600">R$ ${fmt(totalGuardado)} / R$ ${fmt(totalAlvo)}</span>
                </div>
                <div class="w-full bg-gray-200 rounded-full h-3 overflow-hidden">
                    <div class="bg-gradient-to-r from-purple-500 to-green-500 h-3 rounded-full transition-all" style="width: ${progressoGeral}%"></div>
                </div>
            </div>

            <div class="flex flex-wrap gap-2 items-center justify-between bg-white p-3 rounded-lg shadow mb-3">
                <div class="flex items-center gap-2 flex-wrap">
                    <span class="text-xs text-gray-500 mr-1">Status:</span>
                    <button onclick="setMetasStatus('ativas')" class="${chipBase} ${filter.status === 'ativas' ? 'bg-purple-600 text-white' : chipOff}">Ativas</button>
                    <button onclick="setMetasStatus('concluidas')" class="${chipBase} ${filter.status === 'concluidas' ? 'bg-green-600 text-white' : chipOff}">Concluídas</button>
                    <button onclick="setMetasStatus('all')" class="${chipBase} ${filter.status === 'all' ? 'bg-gray-600 text-white' : chipOff}">Todas</button>
                </div>
                <button onclick="showModal('meta')" class="bg-purple-600 text-white px-4 py-2 rounded hover:bg-purple-700 transition inline-flex items-center gap-2">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path></svg>
                    Nova Meta
                </button>
            </div>

            <div class="bg-white p-3 rounded-lg shadow mb-4">
                <input type="search" id="metas-search" value="${escapeHtml(filter.q)}" placeholder="Buscar por nome..." class="w-full p-2 border-2 border-gray-200 rounded-lg focus:border-purple-500 outline-none text-sm" oninput="onSearchInput('metas', this.value)">
            </div>

            ${items.length === 0 ? `
                <div class="bg-white rounded-lg shadow p-10 text-center">
                    <div class="bg-purple-100 w-20 h-20 rounded-full flex items-center justify-center mx-auto mb-4">
                        <svg class="w-10 h-10 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                    </div>
                    <h3 class="font-bold text-gray-700 mb-1">${filter.status === 'concluidas' ? 'Nenhuma meta concluída ainda' : (filter.status === 'ativas' ? 'Nenhuma meta ativa' : 'Nenhuma meta cadastrada')}</h3>
                    <p class="text-sm text-gray-500 mb-4">Defina uma nova meta e acompanhe seu progresso.</p>
                    <button onclick="showModal('meta')" class="bg-purple-600 text-white px-5 py-2 rounded hover:bg-purple-700 transition">+ Nova Meta</button>
                </div>
            ` : `
                <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
                    ${items.map(item => {
                        const alvo = parseFloat(item.valorAlvo || 0);
                        const guardado = parseFloat(item.valorGuardado || 0);
                        const falta = Math.max(alvo - guardado, 0);
                        const pct = alvo > 0 ? Math.min((guardado / alvo) * 100, 100) : 0;
                        const concluida = guardado >= alvo;
                        const dias = diasAte(item.dataLimite);
                        let badge = '';
                        if (concluida) badge = '<span class="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded font-bold">✓ CONCLUÍDA</span>';
                        else if (dias !== null && dias < 0) badge = `<span class="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded font-bold">Prazo vencido</span>`;
                        else if (dias !== null && dias <= 30) badge = `<span class="text-xs bg-yellow-100 text-yellow-700 px-2 py-0.5 rounded font-bold">${dias}d restantes</span>`;
                        else if (dias !== null) badge = `<span class="text-xs text-gray-500">Até ${formatDateBR(item.dataLimite)}</span>`;
                        const barColor = concluida ? 'bg-green-500' : (dias !== null && dias < 0 ? 'bg-red-500' : 'bg-purple-600');
                        return `
                            <div class="bg-white p-4 rounded-lg shadow border-l-4 ${concluida ? 'border-green-500' : 'border-purple-500'} hover:shadow-md transition">
                                <div class="flex justify-between items-start mb-2 gap-2">
                                    <h3 class="font-bold truncate">${item.nome}</h3>
                                    ${badge}
                                </div>
                                <div class="w-full bg-gray-200 rounded-full h-3 mb-2 overflow-hidden">
                                    <div class="${barColor} h-3 rounded-full transition-all" style="width: ${pct}%"></div>
                                </div>
                                <div class="flex justify-between text-xs mb-3">
                                    <span class="text-purple-600 font-bold">R$ ${fmt(guardado)}</span>
                                    <span class="text-gray-600">${pct.toFixed(1)}%</span>
                                    <span class="text-gray-700 font-bold">R$ ${fmt(alvo)}</span>
                                </div>
                                ${!concluida ? `<p class="text-xs text-gray-500 mb-2">Falta <strong class="text-gray-700">R$ ${fmt(falta)}</strong></p>` : ''}
                                <div class="flex justify-between items-center border-t pt-2">
                                    <button onclick="addAporteMeta(${item.id})" class="text-purple-600 text-sm font-medium hover:bg-purple-50 px-2 py-1 rounded transition inline-flex items-center gap-1">
                                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path></svg>
                                        Aporte
                                    </button>
                                    <div class="flex gap-1">
                                        <button onclick="editItem('metas', ${item.id})" class="text-blue-600 p-2 rounded hover:bg-blue-50 transition" title="Editar"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"></path></svg></button>
                                        <button onclick="deleteItem('metas', ${item.id})" class="text-red-600 p-2 rounded hover:bg-red-50 transition" title="Excluir"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg></button>
                                    </div>
                                </div>
                            </div>
                        `;
                    }).join('')}
                </div>
            `}
        `;
        const searchEl = document.getElementById('metas-search');
        if (searchEl && filter.q) {
            const len = searchEl.value.length;
            searchEl.focus();
            try { searchEl.setSelectionRange(len, len); } catch (_) {}
        }
    }

    // --- Módulo 7: Configurações (Backup / Restauração) ---
    const BACKUP_TABLES = ['entradas', 'saidas', 'dividas', 'poupanca', 'metas', 'categorias'];

    async function renderConfiguracoes(container) {
        const counts = {};
        for (const t of BACKUP_TABLES) counts[t] = await db[t].count();
        const total = counts.entradas + counts.saidas + counts.dividas + counts.poupanca + counts.metas;
        const autoLockCfg = await db.config.get('autoLockMinutes');
        const autoLockMin = autoLockCfg ? parseFloat(autoLockCfg.value) : 5;
        const themeCfg = await db.config.get('theme');
        const theme = (themeCfg && themeCfg.value) || 'light';
        const cats = await getCategorias();
        const catsEntrada = cats.filter(c => c.kind === 'entrada');
        const catsSaida = cats.filter(c => c.kind === 'saida');
        const catItem = (c) => `
            <span class="inline-flex items-center gap-1 bg-gray-100 text-gray-700 text-xs px-2 py-1 rounded-full">
                ${escapeHtml(c.nome)}
                <button onclick="deleteCategoria(${c.id}, '${escapeHtml(c.nome).replace(/'/g, "\\'")}', '${c.kind}')" class="text-gray-400 hover:text-red-600 ml-1" title="Excluir">×</button>
            </span>`;

        container.innerHTML = `
            <h2 class="text-xl font-bold mb-4">Configurações</h2>

            <div class="bg-white rounded-lg shadow p-4 mb-4">
                <h3 class="font-bold mb-2">Aparência</h3>
                <label class="block text-sm text-gray-600 mb-1">Tema</label>
                <div class="flex items-center gap-2">
                    <select id="cfg-theme" class="flex-1 p-2 border-2 border-gray-200 rounded-lg focus:border-blue-500 outline-none">
                        <option value="light" ${theme === 'light' ? 'selected' : ''}>Claro</option>
                        <option value="dark" ${theme === 'dark' ? 'selected' : ''}>Escuro</option>
                        <option value="auto" ${theme === 'auto' ? 'selected' : ''}>Seguir sistema</option>
                    </select>
                    <button onclick="saveTheme()" class="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition">Salvar</button>
                </div>
                <p class="text-xs text-gray-500 mt-2">"Seguir sistema" usa a preferência do seu dispositivo (claro ou escuro).</p>
            </div>

            <div class="bg-white rounded-lg shadow p-4 mb-4">
                <h3 class="font-bold mb-2">Segurança</h3>
                <label class="block text-sm text-gray-600 mb-1">Bloquear automaticamente após inatividade</label>
                <div class="flex items-center gap-2">
                    <select id="cfg-autolock" class="flex-1 p-2 border-2 border-gray-200 rounded-lg focus:border-blue-500 outline-none">
                        <option value="0" ${autoLockMin === 0 ? 'selected' : ''}>Desativado</option>
                        <option value="1" ${autoLockMin === 1 ? 'selected' : ''}>1 minuto</option>
                        <option value="5" ${autoLockMin === 5 ? 'selected' : ''}>5 minutos</option>
                        <option value="10" ${autoLockMin === 10 ? 'selected' : ''}>10 minutos</option>
                        <option value="30" ${autoLockMin === 30 ? 'selected' : ''}>30 minutos</option>
                    </select>
                    <button onclick="saveAutoLock()" class="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition">Salvar</button>
                </div>
                <p class="text-xs text-gray-500 mt-2">O app será bloqueado após o tempo escolhido sem interação. Definir como "Desativado" mantém o app aberto até você bloquear manualmente.</p>
            </div>

            <div class="bg-white rounded-lg shadow p-4 mb-4">
                <h3 class="font-bold mb-3">Categorias</h3>
                <div class="mb-3">
                    <div class="flex items-center justify-between mb-2">
                        <span class="text-sm font-medium text-gray-700">Entradas (${catsEntrada.length})</span>
                        <button onclick="addCategoria('entrada')" class="text-xs text-blue-600 hover:underline">+ Nova</button>
                    </div>
                    <div class="flex flex-wrap gap-1">${catsEntrada.map(catItem).join('') || '<span class="text-xs text-gray-400">Nenhuma categoria.</span>'}</div>
                </div>
                <div>
                    <div class="flex items-center justify-between mb-2">
                        <span class="text-sm font-medium text-gray-700">Saídas (${catsSaida.length})</span>
                        <button onclick="addCategoria('saida')" class="text-xs text-blue-600 hover:underline">+ Nova</button>
                    </div>
                    <div class="flex flex-wrap gap-1">${catsSaida.map(catItem).join('') || '<span class="text-xs text-gray-400">Nenhuma categoria.</span>'}</div>
                </div>
                <p class="text-xs text-gray-500 mt-3">Excluir uma categoria nao altera os lancamentos ja criados — eles continuam com o nome antigo gravado.</p>
            </div>

            <div class="bg-white rounded-lg shadow p-4 mb-4">
                <h3 class="font-bold mb-2">Backup dos Dados</h3>
                <p class="text-sm text-gray-600 mb-3">
                    Salve seus dados em um arquivo no seu dispositivo. Use o backup para restaurar caso o cache do navegador seja limpo ou o aplicativo seja reinstalado.
                </p>
                <p class="text-xs text-gray-500 mb-3">
                    Registros atuais: ${counts.entradas} entradas, ${counts.saidas} saídas, ${counts.dividas} dívidas, ${counts.poupanca} poupança, ${counts.metas} metas (total: ${total}).
                </p>
                <button onclick="exportData()" class="w-full bg-blue-600 text-white font-bold py-3 rounded-lg hover:bg-blue-700 transition inline-flex items-center justify-center gap-2">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5m0 0l5-5m-5 5V4"></path></svg>
                    Exportar Backup (JSON)
                </button>
            </div>

            <div class="bg-white rounded-lg shadow p-4 mb-4">
                <h3 class="font-bold mb-2">Restaurar Backup</h3>
                <p class="text-sm text-gray-600 mb-3">
                    Selecione um arquivo de backup (.json) gerado pelo WALLET para restaurar seus dados.
                </p>
                <input type="file" id="import-file" accept="application/json,.json" class="hidden" onchange="importData(event)">
                <button onclick="document.getElementById('import-file').click()" class="w-full bg-green-600 text-white font-bold py-3 rounded-lg hover:bg-green-700 transition inline-flex items-center justify-center gap-2">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M17 8l-5-5m0 0L7 8m5-5v12"></path></svg>
                    Importar Backup (JSON)
                </button>
            </div>

            <div class="bg-yellow-50 border border-yellow-200 rounded-lg p-3 text-xs text-yellow-800">
                <strong>Atenção:</strong> Limpar "Cookies e dados de sites" do navegador apaga seu banco de dados. Faça backups com frequência e guarde o arquivo em local seguro.
            </div>
        `;
    }

    window.saveAutoLock = async () => {
        const v = parseFloat(document.getElementById('cfg-autolock').value);
        await db.config.put({ key: 'autoLockMinutes', value: isNaN(v) ? 0 : v });
        await resetInactivityTimer();
        toast('Configuração salva.', 'success');
    };

    window.saveTheme = async () => {
        const v = document.getElementById('cfg-theme').value;
        await db.config.put({ key: 'theme', value: v });
        applyTheme(v);
        toast('Tema atualizado.', 'success');
    };

    window.addCategoria = async (kind) => {
        const nome = await promptDialog({
            title: 'Nova categoria',
            message: `Nome da categoria (${kind === 'entrada' ? 'entrada' : 'saída'}):`,
            okText: 'Criar'
        });
        if (!nome || !nome.trim()) return;
        try {
            await db.categorias.add({ nome: nome.trim(), kind });
            refreshCategorias();
            toast('Categoria criada.', 'success');
            renderView('configuracoes');
        } catch (err) {
            toast('Categoria ja existe.', 'warning');
        }
    };

    window.deleteCategoria = async (id, nome, kind) => {
        const ok = await confirmDialog({
            title: 'Excluir categoria',
            message: `Excluir a categoria "${nome}"? Lancamentos ja salvos com esse nome NAO sao alterados.`,
            okText: 'Excluir',
            danger: true
        });
        if (!ok) return;
        await db.categorias.delete(id);
        refreshCategorias();
        toast('Categoria removida.', 'success');
        renderView('configuracoes');
    };

    window.exportData = async () => {
        try {
            const data = {};
            for (const t of BACKUP_TABLES) data[t] = await db[t].toArray();
            // Inclui config exceto o PIN
            const configRows = await db.config.toArray();
            data.config = configRows.filter(r => r.key !== 'pin');
            const backup = {
                app: 'WALLET',
                version: 2,
                exportedAt: new Date().toISOString(),
                data
            };
            const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            const dateStr = new Date().toISOString().slice(0, 10);
            a.href = url;
            a.download = `wallet-backup-${dateStr}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            toast('Backup exportado.', 'success');
        } catch (err) {
            console.error(err);
            toast('Erro ao exportar backup: ' + err.message, 'error');
        }
    };

    window.importData = async (event) => {
        const file = event.target.files[0];
        if (!file) return;
        try {
            const text = await file.text();
            const backup = JSON.parse(text);
            if (!backup || !backup.data || typeof backup.data !== 'object') {
                toast('Arquivo inválido. Selecione um backup gerado pelo WALLET.', 'error');
                event.target.value = '';
                return;
            }
            const partes = BACKUP_TABLES
                .map(t => `${t}: ${Array.isArray(backup.data[t]) ? backup.data[t].length : 0}`)
                .join(' · ');
            const cfgCount = Array.isArray(backup.data.config) ? backup.data.config.length : 0;
            const resumo = `${partes}${cfgCount ? ` · config: ${cfgCount}` : ''}`;

            // Modal próprio com três botões
            const mode = await new Promise((resolve) => {
                openModalHTML(`
                    <h2 class="text-lg font-bold mb-2">Restaurar Backup</h2>
                    <p class="text-sm text-gray-600 mb-1">Arquivo carregado.</p>
                    <p class="text-xs text-gray-500 mb-4">${resumo}</p>
                    <p class="text-sm text-gray-700 mb-3">Como deseja restaurar?</p>
                    <div class="flex flex-col gap-2">
                        <button id="im-replace" class="w-full px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 transition text-left">
                            <strong>Substituir</strong> — apaga os dados atuais e usa apenas os do backup
                        </button>
                        <button id="im-merge" class="w-full px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700 transition text-left">
                            <strong>Mesclar</strong> — adiciona os registros do backup aos atuais
                        </button>
                        <button id="im-cancel" class="w-full px-4 py-2 text-gray-700 rounded hover:bg-gray-100 transition">Cancelar</button>
                    </div>
                `);
                document.getElementById('im-replace').onclick = () => { closeModalUI(); resolve('1'); };
                document.getElementById('im-merge').onclick = () => { closeModalUI(); resolve('2'); };
                document.getElementById('im-cancel').onclick = () => { closeModalUI(); resolve(null); };
            });

            if (mode !== '1' && mode !== '2') { event.target.value = ''; return; }

            if (mode === '1') {
                const ok = await confirmDialog({
                    title: 'Confirmar substituição',
                    message: 'Isso vai APAGAR todos os seus dados atuais antes de importar. Tem certeza?',
                    okText: 'Substituir tudo',
                    danger: true
                });
                if (!ok) { event.target.value = ''; return; }
            }

            await db.transaction('rw', [...BACKUP_TABLES.map(t => db[t]), db.config], async () => {
                for (const t of BACKUP_TABLES) {
                    const rows = Array.isArray(backup.data[t]) ? backup.data[t] : [];
                    if (mode === '1') {
                        await db[t].clear();
                        if (rows.length) await db[t].bulkAdd(rows);
                    } else {
                        const rowsNoId = rows.map(({ id, ...rest }) => rest);
                        if (rowsNoId.length) await db[t].bulkAdd(rowsNoId);
                    }
                }
                // Restaura config (sem sobrescrever o PIN atual)
                const cfgRows = Array.isArray(backup.data.config) ? backup.data.config : [];
                for (const r of cfgRows) {
                    if (!r || !r.key || r.key === 'pin') continue;
                    await db.config.put(r);
                }
            });
            toast('Backup restaurado com sucesso!', 'success');
            event.target.value = '';
            renderView('configuracoes');
        } catch (err) {
            console.error(err);
            toast('Erro ao ler o arquivo: ' + err.message, 'error');
            event.target.value = '';
        }
    };

    // --- Funções de CRUD e Modais ---
    // escapeHtml ja foi importado de window.AppUtils no topo do arquivo.

    window.showModal = async (type, id = null) => {
        const modal = document.getElementById('modal');
        const modalBody = document.getElementById('modal-body');
        modal.classList.remove('hidden');

        const titleMap = {
            entrada: 'Nova Entrada', entradas: 'Editar Entrada',
            saida: 'Nova Saída', saidas: 'Editar Saída',
            divida: 'Nova Dívida', dividas: 'Editar Dívida',
            poupanca: id ? 'Editar Lançamento' : 'Novo Lançamento de Poupança',
            meta: 'Nova Meta', metas: 'Editar Meta'
        };
        const title = titleMap[type] || (id ? 'Editar' : 'Novo Registro');
        const today = new Date().toISOString().slice(0, 10);
        const inputCls = 'w-full p-2 border-2 border-gray-200 rounded-lg mb-3 focus:border-blue-500 outline-none';
        const labelCls = 'block text-xs font-medium text-gray-600 mb-1';
        const money = (id_, placeholder) => `<input type="text" id="${id_}" inputmode="decimal" placeholder="${placeholder}" class="${inputCls}">`;
        const isEntrada = (type === 'entrada' || type === 'entradas');
        const isSaida = (type === 'saida' || type === 'saidas');
        const categoriaKind = isEntrada ? 'entrada' : (isSaida ? 'saida' : null);
        const cats = categoriaKind ? await getCategorias(categoriaKind) : [];
        const catOptions = cats.map(c => `<option value="${escapeHtml(c.nome)}">${escapeHtml(c.nome)}</option>`).join('')
            + `<option value="__nova__">+ Nova categoria…</option>`;
        const catBlock = categoriaKind ? `
            <label class="${labelCls}">Categoria</label>
            <select id="m-categoria" class="${inputCls}" onchange="onCategoriaSelectChange('${categoriaKind}', this)">${catOptions}</select>
        ` : '';
        const recorrenteBlock = categoriaKind ? `
            <label class="inline-flex items-center gap-2 text-sm text-gray-700 mb-3 cursor-pointer">
                <input type="checkbox" id="m-recorrente" class="w-4 h-4 rounded border-gray-300">
                <span>Repetir mensalmente (recorrente)</span>
            </label>
        ` : '';
        let fields = '';
        let action = id ? `updateItem('${type}', ${id})` : `saveItem('${type}')`;

        if (isEntrada) {
            fields = `
                <label class="${labelCls}">Descrição</label>
                <input type="text" id="m-desc" placeholder="Ex.: Salário" class="${inputCls}">
                <label class="${labelCls}">Valor (R$)</label>
                ${money('m-valor', 'Ex.: 3500,00')}
                <label class="${labelCls}">Data</label>
                <input type="date" id="m-data" value="${today}" class="${inputCls}">
                ${catBlock}
                ${recorrenteBlock}
            `;
        } else if (isSaida) {
            fields = `
                <label class="${labelCls}">Descrição</label>
                <input type="text" id="m-desc" placeholder="Ex.: Mercado" class="${inputCls}">
                <label class="${labelCls}">Valor (R$)</label>
                ${money('m-valor', 'Ex.: 350,90')}
                <label class="${labelCls}">Data</label>
                <input type="date" id="m-data" value="${today}" class="${inputCls}">
                <label class="${labelCls}">Tipo</label>
                <select id="m-tipo" class="${inputCls}">
                    <option value="fixa">Fixa</option>
                    <option value="variavel">Variável</option>
                </select>
                <label class="${labelCls}">Status</label>
                <select id="m-status" class="${inputCls}">
                    <option value="pendente">Pendente</option>
                    <option value="pago">Pago</option>
                </select>
                ${catBlock}
                ${recorrenteBlock}
            `;
        } else if (type === 'divida' || type === 'dividas') {
            fields = `
                <label class="${labelCls}">Credor</label>
                <input type="text" id="m-nome" placeholder="Ex.: Cartão Nubank" class="${inputCls}">
                <label class="${labelCls}">Valor original (R$)</label>
                ${money('m-valorOriginal', 'Ex.: 5000,00')}
                <label class="${labelCls}">Saldo devedor atual (R$)</label>
                ${money('m-saldoDevedor', 'Ex.: 3200,00')}
                <label class="${labelCls}">Vencimento</label>
                <input type="date" id="m-vencimento" class="${inputCls}">
            `;
        } else if (type === 'poupanca') {
            fields = `
                <label class="${labelCls}">Tipo</label>
                <select id="m-tipo" class="${inputCls}">
                    <option value="reserva">Reserva de Emergência</option>
                    <option value="investimento">Investimento Longo Prazo</option>
                </select>
                <label class="${labelCls}">Valor (R$)</label>
                ${money('m-valor', 'Ex.: 500,00')}
                <label class="${labelCls}">Data</label>
                <input type="date" id="m-data" value="${today}" class="${inputCls}">
            `;
        } else if (type === 'meta' || type === 'metas') {
            fields = `
                <label class="${labelCls}">Nome da meta</label>
                <input type="text" id="m-nome" placeholder="Ex.: Viagem" class="${inputCls}">
                <label class="${labelCls}">Valor alvo (R$)</label>
                ${money('m-valorAlvo', 'Ex.: 5000,00')}
                <label class="${labelCls}">Valor já guardado (R$)</label>
                ${money('m-valorGuardado', 'Ex.: 1200,00 (opcional)')}
                <label class="${labelCls}">Data limite</label>
                <input type="date" id="m-dataLimite" class="${inputCls}">
            `;
        }

        modalBody.innerHTML = `
            <h2 class="text-xl font-bold mb-4">${title}</h2>
            ${fields}
            <div class="flex justify-end mt-2 gap-2">
                <button onclick="closeModal()" class="px-4 py-2 text-gray-700 rounded hover:bg-gray-100 transition">Cancelar</button>
                <button onclick="${action}" class="px-4 py-2 bg-blue-600 text-white font-medium rounded hover:bg-blue-700 transition">Salvar</button>
            </div>
        `;

        if (id) fillModalData(type === 'entrada' ? 'entradas' : type === 'saida' ? 'saidas' : type === 'divida' ? 'dividas' : type === 'meta' ? 'metas' : type, id);
    };

    window.closeModal = () => {
        document.getElementById('modal').classList.add('hidden');
    };

    // Formata valor monetário para edição no input (BR: 1234.5 → "1234,50")
    const moneyForInput = (n) => {
        if (n === null || n === undefined || n === '') return '';
        const v = parseFloat(n);
        return isNaN(v) ? '' : v.toFixed(2).replace('.', ',');
    };
    async function fillModalData(type, id) {
        const item = await db[type].get(id);
        if (!item) return;
        const set = (sel, v) => { const el = document.getElementById(sel); if (el) el.value = v ?? ''; };
        const check = (sel, v) => { const el = document.getElementById(sel); if (el) el.checked = !!v; };
        if (type === 'entradas') {
            set('m-desc', item.descricao); set('m-valor', moneyForInput(item.valor)); set('m-data', item.data);
            set('m-categoria', item.categoria || 'Outros'); check('m-recorrente', item.recorrente);
        } else if (type === 'saidas') {
            set('m-desc', item.descricao); set('m-valor', moneyForInput(item.valor)); set('m-data', item.data);
            set('m-tipo', item.tipo); set('m-status', item.status);
            set('m-categoria', item.categoria || 'Outros'); check('m-recorrente', item.recorrente);
        } else if (type === 'dividas') {
            set('m-nome', item.nome); set('m-valorOriginal', moneyForInput(item.valorOriginal));
            set('m-saldoDevedor', moneyForInput(item.saldoDevedor)); set('m-vencimento', item.vencimento);
        } else if (type === 'poupanca') {
            set('m-tipo', item.tipo); set('m-valor', moneyForInput(item.valor)); set('m-data', item.data);
        } else if (type === 'metas') {
            set('m-nome', item.nome); set('m-valorAlvo', moneyForInput(item.valorAlvo));
            set('m-valorGuardado', moneyForInput(item.valorGuardado)); set('m-dataLimite', item.dataLimite);
        }
    }

    // Cria categoria inline a partir do select (opcao "+ Nova categoria...")
    window.onCategoriaSelectChange = async (kind, selectEl) => {
        if (selectEl.value !== '__nova__') return;
        const nome = await promptDialog({
            title: 'Nova categoria',
            message: `Nome da nova categoria (${kind === 'entrada' ? 'entrada' : 'saída'}):`,
            okText: 'Criar'
        });
        if (!nome || !nome.trim()) { selectEl.value = 'Outros'; return; }
        const nomeOk = nome.trim();
        try {
            await db.categorias.add({ nome: nomeOk, kind });
            refreshCategorias();
            // Re-injeta a opcao na posicao correta (antes do "+ Nova")
            const newOpt = document.createElement('option');
            newOpt.value = nomeOk; newOpt.textContent = nomeOk;
            const novaOpt = Array.from(selectEl.options).find(o => o.value === '__nova__');
            selectEl.insertBefore(newOpt, novaOpt);
            selectEl.value = nomeOk;
            toast('Categoria criada.', 'success');
        } catch (err) {
            toast('Categoria ja existe ou nome invalido.', 'warning');
            selectEl.value = 'Outros';
        }
    };

    // Constrói e valida o payload a partir do form do modal.
    // Retorna { data, error } — se error não é null, exibe toast e cancela.
    const buildPayload = (type) => {
        const val = (sel) => (document.getElementById(sel) ? document.getElementById(sel).value : '').trim();
        const reqText = (v, label) => v ? null : `${label} é obrigatório.`;
        const reqDate = (v, label) => v ? null : `${label} é obrigatória.`;
        const reqMoney = (v, label, { allowZero = false } = {}) => {
            const n = parseValor(v);
            if (isNaN(n)) return `${label} inválido.`;
            if (!allowZero && n <= 0) return `${label} deve ser maior que zero.`;
            if (allowZero && n < 0) return `${label} não pode ser negativo.`;
            return null;
        };
        const norm = (t) => t === 'entrada' ? 'entradas'
            : t === 'saida' ? 'saidas'
            : t === 'divida' ? 'dividas'
            : t === 'meta' ? 'metas'
            : t;
        const table = norm(type);
        let data = {}, error = null;

        const checked = (sel) => { const el = document.getElementById(sel); return el ? (el.checked ? 1 : 0) : 0; };
        const catOrDefault = (sel) => {
            const v = val(sel);
            return (!v || v === '__nova__') ? 'Outros' : v;
        };
        if (table === 'entradas') {
            const desc = val('m-desc'), valor = val('m-valor'), dataI = val('m-data');
            error = reqText(desc, 'Descrição') || reqMoney(valor, 'Valor') || reqDate(dataI, 'Data');
            data = { descricao: desc, valor: parseValor(valor), data: dataI,
                categoria: catOrDefault('m-categoria'), recorrente: checked('m-recorrente') };
        } else if (table === 'saidas') {
            const desc = val('m-desc'), valor = val('m-valor'), dataI = val('m-data');
            error = reqText(desc, 'Descrição') || reqMoney(valor, 'Valor') || reqDate(dataI, 'Data');
            data = { descricao: desc, valor: parseValor(valor), data: dataI, tipo: val('m-tipo'), status: val('m-status'),
                categoria: catOrDefault('m-categoria'), recorrente: checked('m-recorrente') };
        } else if (table === 'dividas') {
            const nome = val('m-nome'), vo = val('m-valorOriginal'), sd = val('m-saldoDevedor'), venc = val('m-vencimento');
            error = reqText(nome, 'Credor') || reqMoney(vo, 'Valor original') || reqMoney(sd, 'Saldo atual', { allowZero: true }) || reqDate(venc, 'Vencimento');
            data = { nome, valorOriginal: parseValor(vo), saldoDevedor: parseValor(sd), vencimento: venc };
        } else if (table === 'poupanca') {
            const valor = val('m-valor'), dataI = val('m-data');
            error = reqMoney(valor, 'Valor') || reqDate(dataI, 'Data');
            data = { tipo: val('m-tipo'), valor: parseValor(valor), data: dataI };
        } else if (table === 'metas') {
            const nome = val('m-nome'), va = val('m-valorAlvo'), vg = val('m-valorGuardado'), dl = val('m-dataLimite');
            error = reqText(nome, 'Nome da meta') || reqMoney(va, 'Valor alvo') || reqMoney(vg || '0', 'Valor guardado', { allowZero: true }) || reqDate(dl, 'Data limite');
            data = { nome, valorAlvo: parseValor(va), valorGuardado: parseValor(vg || '0'), dataLimite: dl };
        }
        return { table, data, error };
    };

    window.saveItem = async (type) => {
        const { table, data, error } = buildPayload(type);
        if (error) { toast(error, 'warning'); return; }
        await db[table].add(data);
        closeModal();
        toast('Registro adicionado.', 'success');
        renderView(state.currentView);
    };

    window.updateItem = async (type, id) => {
        const { table, data, error } = buildPayload(type);
        if (error) { toast(error, 'warning'); return; }
        await db[table].update(id, data);
        closeModal();
        toast('Registro atualizado.', 'success');
        renderView(state.currentView);
    };

    window.deleteItem = async (table, id) => {
        const ok = await confirmDialog({
            title: 'Excluir registro',
            message: 'Tem certeza que deseja excluir este registro? Esta ação não pode ser desfeita.',
            okText: 'Excluir',
            danger: true
        });
        if (!ok) return;
        await db[table].delete(id);
        toast('Registro excluído.', 'success');
        renderView(state.currentView);
    };

    window.editItem = (table, id) => {
        showModal(table, id);
    };

    window.toggleStatus = async (table, id, currentStatus) => {
        const newStatus = currentStatus === 'pago' ? 'pendente' : 'pago';
        await db[table].update(id, { status: newStatus });
        renderView(state.currentView);
    };

    window.changeEntradasMonth = (delta) => {
        state.entradasFilter.month = delta > 0
            ? getNextMonth(state.entradasFilter.month)
            : getPrevMonth(state.entradasFilter.month);
        renderView('entradas');
    };

    window.setEntradasMonth = (value) => {
        if (!value) return;
        state.entradasFilter.month = value;
        renderView('entradas');
    };

    window.toggleEntradasMode = () => {
        state.entradasFilter.mode = state.entradasFilter.mode === 'month' ? 'all' : 'month';
        renderView('entradas');
    };
    window.setEntradasCategoria = (v) => { state.entradasFilter.categoria = v; renderView('entradas'); };

    // --- Filtros: Saídas ---
    window.changeSaidasMonth = (delta) => {
        state.saidasFilter.month = delta > 0 ? getNextMonth(state.saidasFilter.month) : getPrevMonth(state.saidasFilter.month);
        renderView('saidas');
    };
    window.setSaidasMonth = (value) => { if (!value) return; state.saidasFilter.month = value; renderView('saidas'); };
    window.toggleSaidasMode = () => { state.saidasFilter.mode = state.saidasFilter.mode === 'month' ? 'all' : 'month'; renderView('saidas'); };
    window.setSaidasStatus = (s) => { state.saidasFilter.status = s; renderView('saidas'); };
    window.setSaidasTipo = (t) => { state.saidasFilter.tipo = t; renderView('saidas'); };
    window.setSaidasCategoria = (v) => { state.saidasFilter.categoria = v; renderView('saidas'); };

    // --- Filtros: Dívidas ---
    window.setDividasStatus = (s) => { state.dividasFilter.status = s; renderView('dividas'); };
    window.setDividasSort = (s) => { state.dividasFilter.sort = s; renderView('dividas'); };

    // --- Filtros: Poupança ---
    window.changePoupancaMonth = (delta) => {
        state.poupancaFilter.month = delta > 0 ? getNextMonth(state.poupancaFilter.month) : getPrevMonth(state.poupancaFilter.month);
        renderView('poupanca');
    };
    window.setPoupancaMonth = (value) => { if (!value) return; state.poupancaFilter.month = value; renderView('poupanca'); };
    window.togglePoupancaMode = () => { state.poupancaFilter.mode = state.poupancaFilter.mode === 'month' ? 'all' : 'month'; renderView('poupanca'); };
    window.setPoupancaTipo = (t) => { state.poupancaFilter.tipo = t; renderView('poupanca'); };

    // --- Filtros: Metas ---
    window.setMetasStatus = (s) => { state.metasFilter.status = s; renderView('metas'); };

    // --- Busca textual debounced ---
    const _searchTimers = {};
    const _searchTargets = { entradas: 'entradasFilter', saidas: 'saidasFilter', dividas: 'dividasFilter', poupanca: 'poupancaFilter', metas: 'metasFilter' };
    window.onSearchInput = (view, value) => {
        const key = _searchTargets[view];
        if (!key) return;
        clearTimeout(_searchTimers[view]);
        _searchTimers[view] = setTimeout(() => {
            state[key].q = value;
            renderView(view);
        }, 250);
    };

    // --- Dashboard ---
    window.setReservaMeta = async () => {
        const atual = await db.config.get('metaReserva');
        const valorAtual = atual ? parseFloat(atual.value) : 10000;
        const raw = await promptDialog({
            title: 'Meta da reserva de emergência',
            message: `Valor atual: R$ ${fmtBR(valorAtual)}`,
            label: 'Novo valor',
            type: 'money',
            placeholder: 'Ex.: 10000,00',
            initial: String(valorAtual).replace('.', ','),
            validate: (v) => { const n = parseValor(v); return (isNaN(n) || n <= 0) ? 'Informe um valor maior que zero.' : null; }
        });
        if (raw === null) return;
        await db.config.put({ key: 'metaReserva', value: parseValor(raw) });
        toast('Meta atualizada.', 'success');
        renderView('dashboard');
    };

    window.addAporteMeta = async (id) => {
        const meta = await db.metas.get(id);
        if (!meta) return;
        const raw = await promptDialog({
            title: `Aporte: ${meta.nome}`,
            message: `Valor guardado atual: R$ ${fmtBR(meta.valorGuardado)}`,
            label: 'Valor a adicionar',
            type: 'money',
            placeholder: 'Ex.: 250,00',
            validate: (v) => { const n = parseValor(v); return (isNaN(n) || n <= 0) ? 'Informe um valor maior que zero.' : null; }
        });
        if (raw === null) return;
        const valor = parseValor(raw);
        const novoGuardado = parseFloat(meta.valorGuardado || 0) + valor;
        await db.metas.update(id, { valorGuardado: novoGuardado });
        toast(`Aporte de R$ ${fmtBR(valor)} registrado.`, 'success');
        renderView('metas');
    };

    // Inicializar
    checkSecurity();
});
