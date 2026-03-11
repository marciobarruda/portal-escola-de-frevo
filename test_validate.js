
        // ========== DADOS GLOBAIS ==========
        let matriculasData = [];
        let turmasData = [];
        let colunaOrdenacao = null;
        let direcaoOrdenacao = 'asc'; // 'asc' ou 'desc'

        // ========== SESSÃO DO USUÁRIO (RBAC) ==========
        let currentUser = '{{ $json.usuario }}';
        let currentRole = '{{ $json.role }}';
        // Fallback para desenvolvimento local (template não processado pelo n8n)
        if (currentUser.includes('{{')) { currentUser = 'Dev Local'; currentRole = 'dev'; }

        // ========== APLICAR RBAC ==========
        function aplicarRBAC() {
            // 1. Atualizar topbar com dados do usuário logado
            const userNameEl = document.querySelector('.user-menu-name');
            const userRoleEl = document.querySelector('.user-menu-role');
            const userAvatarEl = document.querySelector('.user-avatar');
            if (userNameEl) userNameEl.textContent = currentUser;

            const roleLabels = { dev: 'Desenvolvedor', admin: 'Administrador', staff: 'Atendente' };
            if (userRoleEl) userRoleEl.textContent = roleLabels[currentRole] || currentRole;

            // Gerar iniciais do avatar
            if (userAvatarEl) {
                const partes = currentUser.trim().split(/\s+/);
                const iniciais = partes.length >= 2
                    ? (partes[0][0] + partes[partes.length - 1][0]).toUpperCase()
                    : partes[0].substring(0, 2).toUpperCase();
                userAvatarEl.textContent = iniciais;
            }

            // 2. Restrições por role
            if (currentRole === 'staff') {
                // Remover aba "Administração" do menu
                const navAdmin = document.querySelector('.nav-item[data-target="view-admin"]');
                if (navAdmin) navAdmin.remove();

                // Remover seção de Administração do DOM
                const viewAdmin = document.getElementById('view-admin');
                if (viewAdmin) viewAdmin.remove();

                // Ocultar botão "Nova Turma"
                const btnNovaTurma = document.querySelector('#view-turmas .btn.btn-primary[onclick*="novaTurma"]');
                if (btnNovaTurma) btnNovaTurma.style.display = 'none';

                // Marcar role para ocultar botões de edição na renderização de turmas
                document.body.setAttribute('data-role', 'staff');
            }

            console.log(`[RBAC] Usuário: ${currentUser} | Role: ${currentRole}`);
        }

        // ========== CONSULTAR ALUNO POR CPF ==========
        let cpfConsultaEmAndamento = false;

        // Travar/destravar campos do formulário de matrícula
        function travarFormMatricula(travar) {
            const modal = document.getElementById('modal-matricula');
            if (!modal) return;
            // Todos os inputs/selects/textareas EXCETO CPF e tipo_matricula radios
            const campos = modal.querySelectorAll(
                'input:not(#cpf):not([name="ui_tipo_matricula"]):not([type="hidden"]):not(#anoLetivo), select, textarea'
            );
            campos.forEach(el => {
                el.disabled = travar;
                el.style.opacity = travar ? '0.4' : '1';
            });
            // Travar/destravar abas (impedir navegação entre tabs)
            const tabs = modal.querySelectorAll('.nav-tab:not(:first-child)');
            tabs.forEach(tab => {
                tab.style.pointerEvents = travar ? 'none' : '';
                tab.style.opacity = travar ? '0.4' : '1';
            });
            // Travar/destravar botão salvar
            const btnSalvar = modal.querySelector('.modal-footer .btn-primary');
            if (btnSalvar) {
                btnSalvar.disabled = travar;
                btnSalvar.style.opacity = travar ? '0.4' : '1';
            }
            // Travar/destravar uploads
            const fileInputs = modal.querySelectorAll('input[type="file"]');
            fileInputs.forEach(el => {
                el.disabled = travar;
                el.style.opacity = travar ? '0.4' : '1';
            });
        }

        async function consultarAlunoPorCPF(cpfRaw) {
            const cpf = cpfRaw.replace(/\D/g, '');
            if (cpf.length < 11) {
                showToast('Informe um CPF válido com 11 dígitos.', 'error');
                return;
            }
            if (cpfConsultaEmAndamento) return;

            const nomeInput = document.getElementById('nomeCompleto');
            const btnSalvar = document.querySelector('#modal-matricula .modal-footer .btn-primary');

            // Coletar ano letivo e tipo de matrícula para enviar ao webhook
            const anoLetivo = (document.getElementById('anoLetivo') || {}).value || '';
            const tipoRadio = document.querySelector('input[name="ui_tipo_matricula"]:checked');
            const tipoMatriculaRaw = tipoRadio ? tipoRadio.value : '';
            const tipoMatricula = tipoMatriculaRaw === 'Nova' ? 'Matrícula nova' : tipoMatriculaRaw;

            // Validar preenchimento obrigatório dos 3 campos antes de consultar
            if (!tipoMatricula) {
                showToast('Selecione o tipo de matrícula antes de consultar o CPF.', 'error');
                return;
            }
            if (!anoLetivo) {
                showToast('O ano letivo é obrigatório para a consulta.', 'error');
                return;
            }

            cpfConsultaEmAndamento = true;

            // Indicador visual de loading
            if (nomeInput) { nomeInput.disabled = false; nomeInput.value = 'Consultando...'; nomeInput.style.opacity = '0.5'; }

            try {
                const params = new URLSearchParams({ cpf, ano: anoLetivo, tipo: tipoMatricula });
                const response = await fetch(`https://webhook-n8n-dev-conectarecife.recife.pe.gov.br/webhook/consultar-aluno?${params}`);

                if (!response.ok) {
                    // Aluno não encontrado (404 ou outro erro)
                    if (nomeInput) { nomeInput.value = ''; nomeInput.style.opacity = '1'; }
                    showToast('Aluno não encontrado. Preencha os dados manualmente.', 'info');
                    travarFormMatricula(false); // Desbloquear form para preenchimento manual
                    cpfConsultaEmAndamento = false;
                    return;
                }

                const data = await response.json();
                const mensagemResposta = typeof data === 'string' ? data : (data.mensagem || '');

                if (mensagemResposta === "Já existe matrícula para o aluno informado para este ano letivo.") {
                    if (nomeInput) { nomeInput.value = ''; nomeInput.style.opacity = '1'; }
                    showToast('Já existe matrícula para o aluno neste ano letivo. Redirecionando...', 'error');

                    // Buscar a matrícula na tabela local e abrir no modo leitura
                    const idx = matriculasData.findIndex(m => {
                        const mCpf = (m.cpf_aluno || m.cpf || '').replace(/\D/g, '');
                        return mCpf === cpf;
                    });

                    if (idx !== -1) {
                        closeModal('modal-matricula');
                        setTimeout(() => {
                            abrirMatriculaModal(idx, true);
                        }, 300);
                    } else {
                        if (btnSalvar) { btnSalvar.disabled = true; btnSalvar.style.opacity = '0.5'; }
                    }
                    cpfConsultaEmAndamento = false;
                    return;
                }

                if (mensagemResposta === "Não existe matrícula para o CPF informado no ano anterior") {
                    if (nomeInput) { nomeInput.value = ''; nomeInput.style.opacity = '1'; }
                    showToast('Aluno não encontrado no ano anterior. Preencha os dados manualmente.', 'info');
                    travarFormMatricula(false);
                    cpfConsultaEmAndamento = false;
                    return;
                }

                const aluno = Array.isArray(data) ? data[0] : data;

                if (!aluno || Object.keys(aluno).length === 0) {
                    if (nomeInput) { nomeInput.value = ''; nomeInput.style.opacity = '1'; }
                    showToast('Aluno não encontrado. Preencha os dados manualmente.', 'info');
                    travarFormMatricula(false);
                    cpfConsultaEmAndamento = false;
                    return;
                }

                // Verificar se já possui matrícula ativa no ano atual
                const anoAtual = new Date().getFullYear().toString();
                const statusAluno = (aluno.status || '').toUpperCase();
                const anoAluno = (aluno.ano_letivo || aluno.ano || '').toString();
                if ((statusAluno === 'ATIVA' || aluno.matricula_ativa) && anoAluno === anoAtual) {
                    if (nomeInput) { nomeInput.value = ''; nomeInput.style.opacity = '1'; }
                    showToast('Este aluno já possui uma matrícula ativa para ' + anoAtual + '. Não é possível cadastrar nova matrícula.', 'error');
                    // Manter form travado — usuário deve trocar CPF ou fechar
                    if (btnSalvar) { btnSalvar.disabled = true; btnSalvar.style.opacity = '0.5'; }
                    cpfConsultaEmAndamento = false;
                    return;
                }

                // Desbloquear form e auto-preencher campos com dados do aluno
                travarFormMatricula(false);

                const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ''; };
                const setSelect = (id, val) => {
                    const el = document.getElementById(id);
                    if (!el || !val) return;
                    const upperVal = val.toUpperCase();
                    for (let i = 0; i < el.options.length; i++) {
                        if (el.options[i].text.toUpperCase() === upperVal || el.options[i].value.toUpperCase() === upperVal) {
                            el.selectedIndex = i;
                            return;
                        }
                    }
                };

                // Identificação
                setVal('nomeCompleto', aluno.nome_aluno || aluno.nome || '');
                setVal('datanascimento', aluno.data_nascimento_aluno || aluno.data_nasc || aluno.nascimento || '');
                setVal('idade', aluno.idade_aluno || aluno.idade || '');
                setVal('faixaetaria', aluno.faixa_etaria_aluno || aluno.faixa_etaria || '');
                setSelect('racacor', aluno.raca_cor_aluno || aluno.raca_cor || aluno.raca || '');
                setSelect('genero', aluno.genero_aluno || aluno.genero || '');
                setSelect('possuirg', aluno.possui_rg_aluno || '');

                // Responsável
                setVal('cpfresponsavel', aluno.cpf_responsavel || '');
                setVal('nomeCompletoResponsavel', aluno.nome_responsavel || aluno.nome_resp || '');

                // Mostrar linha de responsável se for menor de idade
                const idadeVal = parseInt(aluno.idade_aluno || aluno.idade) || 0;
                const rowResp = document.getElementById('row-responsavel');
                if (rowResp) rowResp.style.display = (idadeVal > 0 && idadeVal < 18) ? '' : 'none';

                // Saúde
                setSelect('pcd_ask', aluno.pessoa_com_deficiencia || aluno.p_pcd || '');
                setSelect('tipo_def_ask', aluno.tipo_deficiencia || aluno.tipodeficiencia || '');
                setSelect('contraindicacao_medica_ask', aluno.possui_contraindicacao || aluno.contraindicacao || '');
                setVal('qual_contraindicacao_ask', aluno.contraindicacao || aluno.descreva_contradi || '');

                // Endereço
                setVal('cep', aluno.cep_aluno || aluno.cep || '');
                setVal('logradouro', aluno.logradouro_aluno || aluno.logradouro || '');
                setVal('numero', aluno.numero_aluno || aluno.numero || '');
                setVal('complemento', aluno.complemento_aluno || aluno.complemento || '');
                setVal('bairro', aluno.bairro_aluno || aluno.bairro || '');
                setVal('cidade', aluno.cidade_aluno || aluno.cidade || '');
                setVal('whatsapp', aluno.telefone_aluno || aluno.telefone || aluno.whatsapp || '');
                setVal('email', aluno.email_aluno || aluno.email || '');

                if (nomeInput) nomeInput.style.opacity = '1';
                showToast('Dados do aluno preenchidos automaticamente!', 'success');

            } catch (err) {
                console.error('Erro ao consultar aluno:', err);
                if (nomeInput) { nomeInput.value = ''; nomeInput.style.opacity = '1'; }
                showToast('Erro ao consultar aluno. Preencha manualmente.', 'error');
                travarFormMatricula(false); // Desbloquear em caso de erro
            } finally {
                cpfConsultaEmAndamento = false;
            }
        }

        // ========== ORDENAR POR COLUNA (CLIQUE NO HEADER) ==========
        function ordenarPorColuna(campo) {
            // Toggle direção
            if (colunaOrdenacao === campo) {
                direcaoOrdenacao = direcaoOrdenacao === 'asc' ? 'desc' : 'asc';
            } else {
                colunaOrdenacao = campo;
                direcaoOrdenacao = 'asc';
            }

            // Atualizar indicadores visuais
            document.querySelectorAll('#table-main-matriculas th.sortable').forEach(th => {
                th.classList.remove('sort-active');
                const ind = th.querySelector('.sort-indicator');
                if (ind) ind.textContent = '';
            });
            const thAtivo = document.querySelector(`#table-main-matriculas th[data-field="${campo}"]`);
            if (thAtivo) {
                thAtivo.classList.add('sort-active');
                const ind = thAtivo.querySelector('.sort-indicator');
                if (ind) ind.textContent = direcaoOrdenacao === 'asc' ? '↑' : '↓';
            }

            // Re-filtrar (que já re-renderiza)
            filtrarMatriculas();
        }

        // ========== FETCH DE MATRÍCULAS ==========
        async function carregarMatriculas() {
            try {
                const response = await fetch('https://webhook-n8n-dev-conectarecife.recife.pe.gov.br/webhook/listar-matriculas');
                if (!response.ok) throw new Error(`Erro HTTP: ${response.status}`);
                matriculasData = await response.json();

                // Renderizar tabelas
                renderizarTabelaMatriculas(matriculasData, 'tbody-dashboard-matriculas', 10, 'dashboard');
                renderizarTabelaMatriculas(matriculasData, 'tbody-main-matriculas', null, 'main');

                // Atualizar métricas do Dashboard
                atualizarMetricas();
            } catch (erro) {
                console.error('Erro ao carregar matrículas:', erro);
                const msgErro = '<tr><td colspan="9" style="text-align:center; color: var(--secondary-red); padding: 24px;"><i class="ph ph-warning" style="font-size:1.25rem; margin-right:8px;"></i>Erro ao carregar matrículas. Verifique a conexão.</td></tr>';
                document.getElementById('tbody-dashboard-matriculas').innerHTML = msgErro;
                document.getElementById('tbody-main-matriculas').innerHTML = msgErro;
            }
        }

        // ========== FETCH DE TURMAS E POPULAR NÍVEIS ==========
        async function carregarTurmas() {
            try {
                const response = await fetch('https://webhook-n8n-dev-conectarecife.recife.pe.gov.br/webhook/listar-turmas-efr');
                if (!response.ok) throw new Error(`Erro HTTP: ${response.status}`);
                turmasData = await response.json();

                // Extrair e popular níveis dinamicamente a partir das próprias turmas
                const selectNivel = document.getElementById('select-nivel');
                if (selectNivel) {
                    let niveisUnicos = [...new Set(turmasData.map(t => t.nivel).filter(Boolean))];

                    // Lógica de ordenação customizada
                    const getPrioNivel = (n) => {
                        const nl = n.toLowerCase();
                        if (nl.includes('livre')) return 1;
                        if (nl.includes('iniciante')) return 2;
                        if (nl.includes('intermediário') || nl.includes('intermediario')) return 3;
                        if (nl.includes('avançado') || nl.includes('avancado')) return 4;
                        if (nl.includes('master')) return 5;
                        return 99;
                    };

                    niveisUnicos.sort((a, b) => {
                        const wordsA = a.trim().split(/[\s\-]+/).filter(w => w.length > 0);
                        const wordsB = b.trim().split(/[\s\-]+/).filter(w => w.length > 0);

                        // 1. Palavra única vem primeiro
                        const isSingleA = wordsA.length === 1 ? 0 : 1;
                        const isSingleB = wordsB.length === 1 ? 0 : 1;
                        if (isSingleA !== isSingleB) return isSingleA - isSingleB;

                        // 2. Ordem de prioridade (Livre, Iniciante, etc)
                        const prioA = getPrioNivel(a);
                        const prioB = getPrioNivel(b);
                        if (prioA !== prioB) return prioA - prioB;

                        // 3. Desempate alfabético
                        return a.localeCompare(b);
                    });

                    selectNivel.innerHTML = '<option value="">Selecione o Nível</option>';
                    niveisUnicos.forEach(nivel => {
                        const opt = document.createElement('option');
                        opt.value = nivel;
                        opt.textContent = nivel;
                        selectNivel.appendChild(opt);
                    });
                }

                // Renderizar tabelas (apenas ano atual)
                const anoAtual = new Date().getFullYear().toString();
                const turmasAnoAtual = turmasData.filter(t => (t.ano_letivo || '') === anoAtual);
                renderizarTabelaTurmas(turmasAnoAtual, 'tbody-dashboard-turmas', 5, 'dashboard');
                renderizarTabelaTurmas(turmasAnoAtual, 'tbody-main-turmas', null, 'main');
            } catch (erro) {
                console.error('Erro ao carregar turmas:', erro);
                const msgErro = '<tr><td colspan="7" style="text-align:center; color: var(--secondary-red); padding: 24px;"><i class="ph ph-warning" style="font-size:1.25rem; margin-right:8px;"></i>Erro ao carregar turmas.</td></tr>';
                const tbDash = document.getElementById('tbody-dashboard-turmas');
                const tbMain = document.getElementById('tbody-main-turmas');
                if (tbDash) tbDash.innerHTML = msgErro;
                if (tbMain) tbMain.innerHTML = msgErro;
            }
        }

        // ========== RENDERIZAR TABELA DE TURMAS ==========
        function renderizarTabelaTurmas(dados, tbodyId, limite, contexto) {
            const tbody = document.getElementById(tbodyId);
            if (!tbody) return;

            // Ordenar: turmas com saldo > 0 primeiro, preservando ordem original dentro de cada grupo
            const dadosOrdenados = dados.map((item, idx) => ({ item, idx })).sort((a, b) => {
                const saldoA = parseInt(a.item.total_saldo) || 0;
                const saldoB = parseInt(b.item.total_saldo) || 0;
                const temSaldoA = saldoA > 0 ? 0 : 1;
                const temSaldoB = saldoB > 0 ? 0 : 1;
                if (temSaldoA !== temSaldoB) return temSaldoA - temSaldoB;
                return a.idx - b.idx; // preservar ordem original como desempate
            }).map(wrapper => wrapper.item);

            const registros = limite ? dadosOrdenados.slice(0, limite) : dadosOrdenados;

            if (registros.length === 0) {
                const cols = contexto === 'dashboard' ? 6 : 7;
                tbody.innerHTML = `<tr><td colspan="${cols}" style="text-align:center; color: var(--text-muted); padding: 24px;">Nenhuma turma encontrada.</td></tr>`;
                return;
            }

            let html = '';
            registros.forEach((t, idx) => {
                const vagas = parseInt(t.total_vagas) || 0;
                const matriculas = parseInt(t.total_matriculas) || 0;
                const saldo = parseInt(t.total_saldo) || 0;
                const pct = vagas > 0 ? Math.round((matriculas / vagas) * 100) : 0;

                let saldoCor = 'var(--accent-green)';
                let progressClass = 'progress-low';
                if (pct >= 80) { saldoCor = 'var(--secondary-red)'; progressClass = 'progress-high'; }
                else if (pct >= 50) { saldoCor = 'var(--accent-orange)'; progressClass = 'progress-medium'; }

                const tipoLower = (t.tipo || '').toLowerCase();
                let tipoBadge = 'badge-dark';
                if (tipoLower.includes('oficina')) tipoBadge = 'badge-warning';

                if (contexto === 'dashboard') {
                    html += `<tr>
                            <td>${t.id || 'N/A'}</td>
                            <td><span class="badge ${tipoBadge}">${t.tipo || 'N/A'}</span></td>
                            <td>${t.faixa_etaria || 'N/A'} / ${t.nivel || 'N/A'}</td>
                            <td>${t.turma || 'N/A'}</td>
                            <td>${t.professor || 'N/A'}</td>
                            <td>
                                ${vagas} / <span style="color: ${saldoCor}; font-weight: 600;">${saldo}</span>
                                <div class="progress-bar-container" title="${pct}% de vagas consumidas">
                                    <div class="progress-bar-fill ${progressClass}" style="width: ${pct}%;"></div>
                                </div>
                            </td>
                        </tr>`;
                } else {
                    html += `<tr>
                            <td><strong>${t.id || 'N/A'}</strong><br><span class="badge badge-dark">${t.ano_letivo || 'N/A'}</span></td>
                            <td>${t.tipo || 'N/A'}<br><span style="color:var(--text-muted); font-size: 0.8rem;">${t.faixa_etaria || ''}</span></td>
                            <td>${t.turma || 'N/A'}<br><span class="badge badge-dark" style="background:#E2E8F0; color: var(--text-main);">${t.nivel || 'N/A'}</span></td>
                            <td>${t.sala || 'N/A'}</td>
                            <td>${t.professor || 'N/A'}</td>
                            <td>
                                <span>${vagas} / ${matriculas}</span> <br>
                                <span style="color: ${saldoCor}; font-weight:600; font-size:0.85rem;">Saldo: ${saldo}</span>
                                <div class="progress-bar-container" title="${pct}% preenchido">
                                    <div class="progress-bar-fill ${progressClass}" style="width: ${pct}%;"></div>
                                </div>
                            </td>
                            <td>
                                <button class="icon-btn" style="color: var(--primary-blue);" title="Editar Turma" onclick="editarTurma('${t.id}')"><i class="ph ph-pencil-simple"></i></button>
                            </td>
                        </tr>`;
                }
            });

            tbody.innerHTML = html;
        }

        // ========== BUSCAR TURMA CORRESPONDENTE ==========
        function buscarTurmaCorrespondente(anoLetivo, nomeTurma) {
            if (!anoLetivo || !nomeTurma) return null;
            return turmasData.find(t =>
                (t.ano_letivo || '') === String(anoLetivo) &&
                (t.turma || '').toLowerCase() === nomeTurma.toLowerCase()
            ) || null;
        }

        // ========== ORDENAR MATRÍCULAS ==========
        function ordenarMatriculas(dados) {
            // Resolver campo com fallback para nomes antigos
            const resolverCampo = (obj, campo) => {
                if (obj[campo] !== undefined && obj[campo] !== null) return obj[campo];
                // Fallbacks
                const fallbacks = { wfid: 'matricula', tipo_matricula: 'tipo', cpf_aluno: 'cpf', nome_aluno: 'nome' };
                if (fallbacks[campo] && obj[fallbacks[campo]] !== undefined) return obj[fallbacks[campo]];
                return '';
            };

            // Status sempre como primeiro critério (Ativa primeiro)
            const statusPrio = { 'ativa': 0, 'trancada': 1, 'encerrada': 2 };
            const getStatusPrio = (item) => statusPrio[(item.status || '').toLowerCase()] ?? 9;

            // Se o usuário clicou em uma coluna, ordenar por ela (mas status sempre primeiro)
            if (colunaOrdenacao) {
                const campo = colunaOrdenacao;
                const mult = direcaoOrdenacao === 'asc' ? 1 : -1;
                return [...dados].sort((a, b) => {
                    // Status sempre primeiro
                    const sA = getStatusPrio(a);
                    const sB = getStatusPrio(b);
                    if (sA !== sB) return sA - sB;

                    let valA = (resolverCampo(a, campo) || '').toString().toLowerCase();
                    let valB = (resolverCampo(b, campo) || '').toString().toLowerCase();
                    const numA = parseFloat(valA);
                    const numB = parseFloat(valB);
                    if (!isNaN(numA) && !isNaN(numB)) {
                        return (numA - numB) * mult;
                    }
                    if (valA < valB) return -1 * mult;
                    if (valA > valB) return 1 * mult;
                    return 0;
                });
            }

            // Ordenação padrão: Status (Ativa primeiro)   Ano DESC   Tipo (Renovação/Nova antes de Oficina)   Nome ASC
            const tipoPrio = (t) => {
                const tl = (t || '').toLowerCase();
                if (tl.includes('renova')) return 0;
                if (tl === 'nova' || tl === 'matrícula nova') return 0;
                if (tl.includes('oficina')) return 1;
                return 0;
            };
            return [...dados].sort((a, b) => {
                // 1. Status: Ativa primeiro
                const sA = getStatusPrio(a);
                const sB = getStatusPrio(b);
                if (sA !== sB) return sA - sB;

                // 2. Ano DESC
                const anoA = parseInt(a.ano_letivo) || 0;
                const anoB = parseInt(b.ano_letivo) || 0;
                if (anoB !== anoA) return anoB - anoA;

                // 3. Tipo: Renovação/Nova antes de Oficina
                const tA = tipoPrio(a.tipo_matricula || a.tipo);
                const tB = tipoPrio(b.tipo_matricula || b.tipo);
                if (tA !== tB) return tA - tB;

                // 4. Nome ASC
                const nomeA = (a.nome_aluno || a.nome || '').toLowerCase();
                const nomeB = (b.nome_aluno || b.nome || '').toLowerCase();
                if (nomeA < nomeB) return -1;
                if (nomeA > nomeB) return 1;
                return 0;
            });
        }

        // ========== RENDERIZAR TABELA ==========
        function renderizarTabelaMatriculas(dados, tbodyId, limite, contexto) {
            const tbody = document.getElementById(tbodyId);
            if (!tbody) return;

            // Ordenar antes de renderizar
            const dadosOrdenados = ordenarMatriculas(dados);
            const registros = limite ? dadosOrdenados.slice(0, limite) : dadosOrdenados;

            if (registros.length === 0) {
                tbody.innerHTML = '<tr><td colspan="9" style="text-align:center; color: var(--text-muted); padding: 24px;">Nenhuma matrícula encontrada.</td></tr>';
                return;
            }

            const anoAtual = new Date().getFullYear().toString();

            let html = '';
            registros.forEach((m, index) => {
                // Badge do tipo
                let tipoBadgeClass = 'badge-dark';
                const tipoOriginal = m.tipo_matricula || m.tipo || 'N/A';
                const tipoLower = tipoOriginal.toLowerCase();
                let tipoLabel = tipoOriginal;
                if (tipoLower === 'renovação') { tipoBadgeClass = 'badge-success'; tipoLabel = 'Renovação'; }
                else if (tipoLower === 'matrícula nova' || tipoLower === 'nova') { tipoBadgeClass = 'badge-dark'; tipoLabel = 'Nova'; }
                else if (tipoLower === 'oficina de férias') { tipoBadgeClass = 'badge-warning'; tipoLabel = 'Oficina'; }

                // Badge do status
                let statusHtml = '';
                const status = (m.status || '').toUpperCase();
                if (status === 'ATIVA') {
                    statusHtml = '<span class="badge badge-success" style="background-color: var(--accent-green); color: white; margin-bottom: 4px; display: inline-block;">Ativa</span>';
                } else if (status === 'ENCERRADA') {
                    statusHtml = '<span class="badge badge-danger" style="margin-bottom: 4px; display: inline-block;">Encerrada</span>';
                } else if (status === 'TRANCADA') {
                    statusHtml = '<span class="badge badge-warning" style="margin-bottom: 4px; display: inline-block;">Trancada</span>';
                } else {
                    statusHtml = `<span class="badge badge-dark" style="margin-bottom: 4px; display: inline-block;">${m.status || 'N/A'}</span>`;
                }

                // Formatar CPF
                const cpfFormatado = formatarCPF(m.cpf_aluno || m.cpf || '');

                // Turma
                const turmaResumo = m.turma || 'N/A';

                // Ano letivo
                const anoLetivo = m.ano_letivo || 'N/A';

                // Índice global no array original (matriculasData)
                const idxGlobal = matriculasData.indexOf(m);

                // Regra de edição: só pode editar se status ATIVA e ano_letivo == ano atual
                const podeEditar = (status === 'ATIVA' && anoLetivo === anoAtual);

                // Botões de ação
                let acoesHtml = '';
                if (contexto === 'dashboard') {
                    acoesHtml = `<button class="icon-btn" style="color: var(--primary-blue);" title="Visualizar" onclick="abrirMatriculaModal(${idxGlobal}, true)"><i class="ph ph-eye"></i></button>`;
                } else {
                    acoesHtml = `<button class="icon-btn" style="color: var(--text-muted);" title="Visualizar" onclick="abrirMatriculaModal(${idxGlobal}, true)"><i class="ph ph-eye"></i></button>`;
                    if (podeEditar) {
                        // Botão Validar Parecer: apenas se ativa e parecer_valido é nulo
                        if (!m.parecer_valido && m.parecer_valido !== 'Sim' && m.parecer_valido !== 'Não') {
                            acoesHtml += `<button class="icon-btn" style="color: var(--accent-orange);" title="Validar parecer médico" onclick="abrirMatriculaModal(${idxGlobal}, true, 'tab-documentacao', true)"><i class="ph ph-stethoscope"></i></button>`;
                        }
                        acoesHtml += `<button class="icon-btn" style="color: var(--primary-blue);" title="Editar Matrícula" onclick="abrirMatriculaModal(${idxGlobal}, false)"><i class="ph ph-pencil-simple"></i></button>`;
                        acoesHtml += `<button class="icon-btn" style="color: var(--secondary-red);" title="Trancar/Cancelar"><i class="ph ph-prohibit"></i></button>`;
                    }
                }

                html += `<tr>
                        <td>${m.wfid || m.matricula || 'N/A'}</td>
                        <td><span class="badge badge-dark">${anoLetivo}</span></td>
                        <td><span class="badge ${tipoBadgeClass}">${tipoLabel}</span></td>
                        <td>${cpfFormatado}</td>
                        <td>${m.nome_aluno || m.nome || 'N/A'}</td>
                        <td>${turmaResumo}</td>
                        <td>${m.nivel_atual || 'N/A'}</td>
                        <td>${statusHtml}</td>
                        <td>${acoesHtml}</td>
                    </tr>`;
            });

            tbody.innerHTML = html;
        }

        // ==========================================
        // SISTEMA DE TOAST (NOTIFICAÇÕES)
        // ==========================================
        function showToast(message, type = 'success') {
            const container = document.getElementById('toast-container');
            if (!container) return;

            const toast = document.createElement('div');
            toast.className = `toast ${type}`;
            const iconClass = type === 'success' ? 'ph-check-circle' : 'ph-warning-circle';

            toast.innerHTML = `
                <i class="ph ${iconClass}"></i>
                <span>${message}</span>
            `;

            container.appendChild(toast);

            requestAnimationFrame(() => toast.classList.add('show'));

            setTimeout(() => {
                toast.classList.remove('show');
                setTimeout(() => {
                    if (container.contains(toast)) container.removeChild(toast);
                }, 300);
            }, 4000);
        }

        // ========== FUNÇÕES GLOBAIS DE INICIALIZA!ÒO E UI ==========
        let matriculaSelecionadaId = null;
        let turmaSelecionadaId = null;

        // ========== FORMATAR CPF ==========
        function formatarCPF(cpf) {
            const c = cpf.replace(/\D/g, '');
            if (c.length !== 11) return cpf;
            return `${c.slice(0, 3)}.${c.slice(3, 6)}.${c.slice(6, 9)}-${c.slice(9)}`;
        }

        // ========== ATUALIZAR MÉTRICAS ==========
        function atualizarMetricas() {
            const total = matriculasData.length;
            const ativas = matriculasData.filter(m => (m.status || '').toUpperCase() === 'ATIVA').length;
            const oficinas = matriculasData.filter(m => (m.tipo_matricula || m.tipo || '').toLowerCase() === 'oficina de férias').length;

            const elTotal = document.getElementById('metric-total-matriculas');
            const elAtivas = document.getElementById('metric-ativas');
            const elOficina = document.getElementById('metric-oficina');

            if (elTotal) elTotal.textContent = total.toLocaleString('pt-BR');
            if (elAtivas) elAtivas.textContent = ativas.toLocaleString('pt-BR');
            if (elOficina) elOficina.textContent = oficinas.toLocaleString('pt-BR');
        }

        // ========== PREENCHER MODAL COM DADOS ==========
        function preencherModalMatricula(m) {
            const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ''; };
            const setSelect = (id, val) => {
                const el = document.getElementById(id);
                if (!el) return;
                const upperVal = (val || '').toUpperCase();
                for (let i = 0; i < el.options.length; i++) {
                    if (el.options[i].text.toUpperCase() === upperVal || el.options[i].value.toUpperCase() === upperVal) {
                        el.selectedIndex = i;
                        return;
                    }
                }
            };

            // Número da matrícula (wfid) no badge do header
            const numBadge = document.getElementById('modal-matricula-numero');
            if (numBadge) {
                if (m.wfid) {
                    numBadge.textContent = `Matrícula #${m.wfid}`;
                    numBadge.style.display = 'inline-block';
                } else {
                    numBadge.style.display = 'none';
                }
            }

            // Identificação
            setVal('anoLetivo', m.ano_letivo);
            setVal('proximonivel', m.proximo_nivel);
            setVal('cpf', formatarCPF(m.cpf_aluno || m.cpf || ''));
            setVal('nomeCompleto', m.nome_aluno || m.nome);
            setVal('datanascimento', m.data_nascimento_aluno || m.nascimento);
            setVal('idade', m.idade_aluno || m.idade);
            setVal('faixaetaria', m.faixa_etaria_aluno || m.faixa_etaria);
            setSelect('racacor', m.raca_cor_aluno || m.raca);
            setSelect('genero', m.genero_aluno || m.genero);
            setSelect('possuirg', m.possui_rg_aluno);

            // Responsável
            setVal('cpfresponsavel', m.cpf_responsavel);
            setVal('nomeCompletoResponsavel', m.nome_responsavel);

            // Mostrar "Responsável" apenas se Aluno < 18 anos ou possui deficiência Intelectual
            const rowResponsavel = document.getElementById('row-responsavel');
            if (rowResponsavel) {
                const idadeVal = parseInt(m.idade_aluno || m.idade) || 0;
                const isPCDIntelectual = (m.tipo_deficiencia || '').toLowerCase() === 'intelectual'
                    || (m.descricao_deficiencia || '').toLowerCase().includes('intelectual');

                if ((idadeVal > 0 && idadeVal < 18) || isPCDIntelectual) {
                    rowResponsavel.style.display = '';
                } else {
                    rowResponsavel.style.display = 'none';
                }
            }

            // Contato
            setVal('email', m.email_aluno || m.email);
            setVal('confirmarEmail', m.email_aluno || m.email);
            const telFormatado = m.telefone_aluno || m.telefone || '';
            setVal('whatsapp', telFormatado);
            setVal('confirmarWhatsApp', telFormatado);

            // Endereço
            setVal('cep', m.cep_aluno || m.cep);
            setVal('logradouro', m.logradouro_aluno || m.logradouro);
            setVal('numero', m.numero_aluno || m.numero);
            setVal('complemento', m.complemento_aluno || m.complemento);
            setVal('bairro', m.bairro_aluno || m.bairro);
            setVal('cidade', m.cidade_aluno || m.cidade);

            // Saúde
            setSelect('pcd_ask', m.pessoa_com_deficiencia);
            setSelect('tipo_def_ask', m.tipo_deficiencia);
            setSelect('qual_deficiencia_ask', m.descricao_deficiencia || m.tipo_deficiencia);
            setSelect('contraindicacao_medica_ask', m.possui_contraindicacao);
            setVal('qual_contraindicacao_ask', m.contraindicacao);

            // Atividade física: pode ser "Sim" ou a descrição da atividade
            const atv = m.atividade_fisica || '';
            if (atv.toUpperCase() === 'SIM' || atv.toUpperCase() === 'NÒO') {
                setSelect('realiza_atv_ask', atv);
                setVal('descreva_atv_ask', '');
            } else if (atv) {
                setSelect('realiza_atv_ask', 'Sim');
                setVal('descreva_atv_ask', atv);
            }

            // Medicamento contínuo
            const med = m.medicamento_continuo || '';
            if (med.toUpperCase() === 'SIM' || med.toUpperCase() === 'NÒO') {
                setSelect('usa_mediamento_ask', med);
                setVal('descreva_medicamento_ask', '');
            } else if (med) {
                setSelect('usa_mediamento_ask', 'Sim');
                setVal('descreva_medicamento_ask', med);
            }

            // Alergia
            const alg = m.alergia || '';
            if (alg.toUpperCase() === 'SIM' || alg.toUpperCase() === 'NÒO') {
                setSelect('alergia_ask', alg);
                setVal('descreva_alergia_ask', '');
            } else if (alg) {
                setSelect('alergia_ask', 'Sim');
                setVal('descreva_alergia_ask', alg);
            }

            // Turma
            setVal('modalidade', m.modalidade);
            // Cruzar com turmasData para obter dias, horário, sala, professor
            const turmaRef = buscarTurmaCorrespondente(m.ano_letivo, m.turma);
            if (turmaRef) {
                setVal('dias', turmaRef.dias);
                setVal('horario', turmaRef.horario);
                setVal('local', turmaRef.sala);
                setVal('professor', turmaRef.professor);
            } else {
                setVal('dias', '');
                setVal('horario', '');
                setVal('local', '');
                setVal('professor', '');
            }
            // Turma (select)
            const turmaSelect = document.getElementById('turma');
            if (turmaSelect && m.turma) {
                let found = false;
                for (let i = 0; i < turmaSelect.options.length; i++) {
                    if (turmaSelect.options[i].text === m.turma || turmaSelect.options[i].value === m.turma) {
                        turmaSelect.selectedIndex = i;
                        found = true;
                        break;
                    }
                }
                if (!found) {
                    const opt = document.createElement('option');
                    opt.value = m.turma;
                    opt.textContent = m.turma;
                    opt.selected = true;
                    turmaSelect.appendChild(opt);
                }
            }
            // Nível (select)
            const nivelSelect = document.getElementById('nivel');
            if (nivelSelect && m.nivel_atual) {
                let found = false;
                for (let i = 0; i < nivelSelect.options.length; i++) {
                    if (nivelSelect.options[i].text === m.nivel_atual || nivelSelect.options[i].value === m.nivel_atual) {
                        nivelSelect.selectedIndex = i;
                        found = true;
                        break;
                    }
                }
                if (!found) {
                    const opt = document.createElement('option');
                    opt.value = m.nivel_atual;
                    opt.textContent = m.nivel_atual;
                    opt.selected = true;
                    nivelSelect.appendChild(opt);
                }
            }

            // Tipo de matrícula (radio buttons)
            const radios = document.querySelectorAll('input[name="ui_tipo_matricula"]');
            const tipoApi = (m.tipo_matricula || m.tipo || '').toLowerCase();
            radios.forEach(r => {
                const valLower = r.value.toLowerCase();
                r.checked = (valLower === tipoApi ||
                    (valLower === 'nova' && tipoApi === 'matrícula nova') ||
                    (valLower === 'oficina de férias' && tipoApi === 'oficina de férias'));
            });
            setVal('tipo', m.tipo_matricula || m.tipo);
            setVal('tipoMatricula', m.tipo_matricula || m.tipo);

            // Documentos base64 (para modo visualização)
            window._currentMatriculaDocs = {
                rg_frente: m.anexo_rg_frente_base64 || m.rg_frente || null,
                rg_verso: m.anexo_rg_verso_base64 || m.rg_verso || null,
                certidao_nasc: m.anexo_cn_base64 || m.certidao_nasc || null,
                parecer_medico: m.anexo_parecer_base64 || m.parecer_medico || null,
                parecer_valido: m.parecer_valido || null
            };

            // Parecer válido (radio)
            const radioSim = document.getElementById('parecer_valido_sim');
            const radioNao = document.getElementById('parecer_valido_nao');
            if (radioSim) radioSim.checked = (m.parecer_valido === 'Sim');
            if (radioNao) radioNao.checked = (m.parecer_valido === 'Não');
            if (m.parecer_valido !== 'Sim' && m.parecer_valido !== 'Não') {
                if (radioSim) radioSim.checked = false;
                if (radioNao) radioNao.checked = false;
            }

            // Autorização de imagem
            const autoImgRadios = document.querySelectorAll('input[name="autoriza_imagem"]');
            autoImgRadios.forEach(r => { r.checked = (r.value === (m.autorizacao_uso_imagem || 'Sim')); });

            // Último registro/atualização (footer)
            const ulInfo = document.getElementById('ultimo-registro-info');
            const ulTs = document.getElementById('ultimo-registro-timestamp');
            const ulUser = document.getElementById('ultimo-registro-user');
            if (m.timestamp && ulInfo && ulTs && ulUser) {
                ulInfo.style.display = 'block';
                // Formatar timestamp para fuso de Recife
                try {
                    const dt = new Date(m.timestamp);
                    ulTs.textContent = dt.toLocaleString('pt-BR', { timeZone: 'America/Recife', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
                } catch (e) {
                    ulTs.textContent = m.timestamp;
                }
                ulUser.textContent = m.email_logado || '';
            } else if (ulInfo) {
                ulInfo.style.display = 'none';
            }

            // Resetar para primeira aba
            const modalEl = document.getElementById('modal-matricula');
            const firstTab = modalEl.querySelector('.nav-tab');
            if (firstTab) switchTab(firstTab, 'modal-matricula');
        }

        // ========== NOVA MATRÍCULA (FORMULÁRIO VAZIO) ==========
        function novaMatricula() {
            // Limpar todos os campos do formulário
            const modal = document.getElementById('modal-matricula');
            if (!modal) return;
            const forms = modal.querySelectorAll('form');
            forms.forEach(f => f.reset());

            // Limpar selects e inputs manualmente
            modal.querySelectorAll('input[type="text"], input[type="email"], input[type="tel"], input[type="number"], input[type="date"]').forEach(el => el.value = '');
            modal.querySelectorAll('select').forEach(el => el.selectedIndex = 0);
            modal.querySelectorAll('input[type="radio"]').forEach(el => el.checked = false);
            modal.querySelectorAll('input[type="file"]').forEach(el => el.value = '');

            // Definir ano letivo como ano atual
            const anoEl = document.getElementById('anoLetivo');
            if (anoEl) anoEl.value = new Date().getFullYear().toString();

            // Modo edição: mostrar uploads, confirmações, botão turma
            const docsEdit = document.getElementById('docs-edit-mode');
            const docsView = document.getElementById('docs-view-mode');
            const laudoEdit = document.getElementById('laudo-edit-mode');
            const laudoView = document.getElementById('laudo-view-mode');
            if (docsEdit) docsEdit.style.display = 'block';
            if (docsView) docsView.style.display = 'none';
            if (laudoEdit) laudoEdit.style.display = 'block';
            if (laudoView) laudoView.style.display = 'none';
            document.querySelectorAll('.confirm-field').forEach(el => el.style.display = '');
            const btnTurma = document.getElementById('btn-escolher-turma');
            if (btnTurma) btnTurma.style.display = '';

            // Ocultar último registro
            const ulInfo = document.getElementById('ultimo-registro-info');
            if (ulInfo) ulInfo.style.display = 'none';

            // Título do modal e badge de matrícula (próximo número)
            const titulo = document.querySelector('#modal-matricula .modal-title');
            if (titulo) titulo.textContent = 'Nova Matrícula';
            const numBadge = document.getElementById('modal-matricula-numero');
            if (numBadge) {
                const maxWfid = matriculasData.reduce((max, m) => {
                    const n = parseInt(m.wfid) || 0;
                    return n > max ? n : max;
                }, 0);
                const proxNum = maxWfid + 1;
                numBadge.textContent = `Matrícula #${proxNum}`;
                numBadge.style.display = 'inline-block';
            }

            // Configurar botões de turma e ocultar timestamp
            const docsEditN = document.getElementById('docs-edit-mode');
            const laudoEditN = document.getElementById('laudo-edit-mode');
            if (docsEditN) docsEditN.style.display = 'block';
            if (laudoEditN) laudoEditN.style.display = 'block';
            document.querySelectorAll('.confirm-field').forEach(el => el.style.display = 'block');
            const btTurma = document.getElementById('btn-escolher-turma');
            if (btTurma) btTurma.style.display = 'inline-block';

            openModal('modal-matricula', false);

            // Travar todos os campos exceto tipo de matrícula e CPF
            // O usuário só poderá editar o restante após o processamento do CPF
            travarFormMatricula(true);
        }

        // ========== NOVA TURMA ==========
        function novaTurma() {
            turmaSelecionadaId = null;
            const form = document.getElementById('formTurma');
            if (form) {
                form.reset();
                const selects = form.querySelectorAll('select');
                selects.forEach(select => {
                    select.value = ''; // Force empty value for all selects
                });
                const inputs = form.querySelectorAll('input:not([type="radio"]):not([type="checkbox"])');
                inputs.forEach(input => {
                    input.value = '';
                });
            }

            const anoLetivoSelect = document.getElementById('turma_ano_letivo');
            if (anoLetivoSelect) {
                anoLetivoSelect.value = new Date().getFullYear().toString();
            }

            const modalEl = document.getElementById('modal-turma');
            const titulo = modalEl?.querySelector('.modal-title');
            if (titulo) titulo.innerHTML = 'CADASTRAR TURMA';

            openModal('modal-turma', false);
        }

        // ========== EDITAR TURMA ==========
        function editarTurma(turmaId) {
            console.log("editarTurma clicked with ID:", turmaId);
            turmaSelecionadaId = turmaId;
            const t = turmasData.find(item => String(item.id) === String(turmaId));
            console.log("Turma encontrada:", t);
            if (!t) return;

            const form = document.getElementById('formTurma');
            if (form) form.reset();

            const modalEl = document.getElementById('modal-turma');
            const titulo = modalEl?.querySelector('.modal-title');
            if (titulo) titulo.textContent = 'EDITAR TURMA';

            // Preencher campos
            const setValByName = (name, value) => {
                const el = form.querySelector(`[name="${name}"]`);
                if (el) el.value = value || '';
            };
            const setSelectByText = (selectEl, text) => {
                if (!selectEl || !text) return;
                const txt = String(text).toLowerCase().trim();
                for (let i = 0; i < selectEl.options.length; i++) {
                    const optText = selectEl.options[i].text.toLowerCase().trim();
                    const optVal = selectEl.options[i].value.toLowerCase().trim();

                    // Match exato
                    if (optText === txt || optVal === txt) {
                        selectEl.selectedIndex = i;
                        return;
                    }

                    // Match parcial robusto (ex: API manda "Livre", Option é "Livre - Roda de Frevo")
                    // Ou API manda "Avançado", Option é "Avançado - Tecno Frevo"
                    const txtWords = txt.split(/[\s\-]+/);
                    const optWords = optText.split(/[\s\-]+/);

                    // Se a primeira palavra chave combinar (ex: Iniciante, Avançado, Livre)
                    if (txtWords[0] === optWords[0] || optText.includes(txt) || txt.includes(optText)) {
                        selectEl.selectedIndex = i;
                        return;
                    }
                }
            };
            const setRadio = (name, val) => {
                if (!val) return;
                const radios = form.querySelectorAll(`input[name="${name}"]`);
                const v = String(val).toLowerCase();
                radios.forEach(r => {
                    if (r.value.toLowerCase() === v || (v.includes('oficina') && r.value.toLowerCase().includes('oficina'))) {
                        r.checked = true;
                    }
                });
            };

            // Mapeando dados para os selects buscando pelo texto do label associado
            const setSelectByLabel = (labelText, value) => {
                const labels = Array.from(form.querySelectorAll('label.form-label'));
                const targetLabel = labels.find(l => l.textContent.toLowerCase().includes(labelText.toLowerCase()));
                if (targetLabel) {
                    const group = targetLabel.closest('.form-group');
                    if (group) {
                        const selectEl = group.querySelector('select');
                        if (selectEl) {
                            setSelectByText(selectEl, value);
                        }
                    }
                }
            };

            setSelectByLabel('Ano letivo', t.ano_letivo);
            setSelectByLabel('Faixa etária', t.faixa_etaria);
            setSelectByLabel('Nível', t.nivel);
            setSelectByLabel('Modalidade', t.modalidade);
            setSelectByLabel('Dias', t.dias);
            setSelectByLabel('Horário', t.horario);
            setSelectByLabel('Sala', t.sala);
            setSelectByLabel('Professor', t.professor);

            // Se for Cadastro Existente, o nome da turma é exibido como título/subtítulo
            if (titulo) {
                titulo.innerHTML = `EDITAR TURMA<br><span style="font-size: 0.9rem; font-weight: normal; color: rgba(255,255,255,0.9); text-transform: none; display: block; margin-top: 4px;">${t.turma || ''}</span>`;
            }

            // Radios e Vagas
            setRadio('tipo_cad_turma', 'Existente');
            setRadio('tipo_turma_mod', t.tipo);
            const vagasInput = form.querySelector('input[type="number"]');
            if (vagasInput && t.total_vagas) vagasInput.value = t.total_vagas;

            openModal('modal-turma', false);
        }

        // ========== ABRIR MODAL COM DADOS ==========
        function abrirMatriculaModal(index, isReadOnly, abaInicial, validarParecer) {
            const m = matriculasData[index];
            if (!m) return;

            // Título do modal
            const modalEl = document.getElementById('modal-matricula');
            const titulo = modalEl?.querySelector('.modal-title');
            if (titulo) titulo.textContent = 'Detalhes da matrícula';

            preencherModalMatricula(m);

            // Toggle modos doc: edit vs view
            const docsEdit = document.getElementById('docs-edit-mode');
            const docsView = document.getElementById('docs-view-mode');
            const laudoEdit = document.getElementById('laudo-edit-mode');
            const laudoView = document.getElementById('laudo-view-mode');

            if (isReadOnly) {
                // Modo visualização: mostrar thumbnails, ocultar confirmações
                if (docsEdit) docsEdit.style.display = 'none';
                if (docsView) docsView.style.display = 'block';
                if (laudoEdit) laudoEdit.style.display = 'none';
                if (laudoView) laudoView.style.display = 'block';
                renderizarThumbnails(m);
                document.querySelectorAll('.confirm-field').forEach(el => el.style.display = 'none');
                // Ocultar botão Escolher Outra Turma
                const btnTurma = document.getElementById('btn-escolher-turma');
                if (btnTurma) btnTurma.style.display = 'none';
            } else {
                // Modo edição: mostrar uploads e confirmações
                if (docsEdit) docsEdit.style.display = 'block';
                if (docsView) docsView.style.display = 'none';
                if (laudoEdit) laudoEdit.style.display = 'block';
                if (laudoView) laudoView.style.display = 'none';
                document.querySelectorAll('.confirm-field').forEach(el => el.style.display = '');
                // Mostrar botão Escolher Outra Turma
                const btnTurma = document.getElementById('btn-escolher-turma');
                if (btnTurma) btnTurma.style.display = '';
            }

            openModal('modal-matricula', isReadOnly);

            // Validar parecer: re-habilitar radios de parecer após abrir read-only
            if (validarParecer) {
                const parecerSim = document.getElementById('parecer_valido_sim');
                const parecerNao = document.getElementById('parecer_valido_nao');
                if (parecerSim) { parecerSim.disabled = false; parecerSim.tabIndex = 0; }
                if (parecerNao) { parecerNao.disabled = false; parecerNao.tabIndex = 0; }
                // Re-habilitar pointer-events apenas para a seção do parecer
                const parecerContainer = parecerSim?.closest('.form-group');
                if (parecerContainer) parecerContainer.style.pointerEvents = 'auto';
            }

            // Se recebeu aba inicial, navegar para ela
            if (abaInicial) {
                const modalEl = document.getElementById('modal-matricula');
                const targetTab = modalEl.querySelector(`.nav-tab[data-tab="${abaInicial}"]`);
                if (targetTab) switchTab(targetTab, 'modal-matricula');
            }
        }

        // ========== RENDERIZAR THUMBNAILS DE DOCUMENTOS ==========
        function renderizarThumbnails(m) {
            const docs = [
                { fields: ['anexo_rg_frente_base64', 'rg_frente'], thumbId: 'thumb-rg-frente', imgId: 'thumb-rg-frente-img', linkId: 'thumb-rg-frente-link' },
                { fields: ['anexo_rg_verso_base64', 'rg_verso'], thumbId: 'thumb-rg-verso', imgId: 'thumb-rg-verso-img', linkId: 'thumb-rg-verso-link' },
                { fields: ['anexo_cn_base64', 'certidao_nasc'], thumbId: 'thumb-certidao', imgId: 'thumb-certidao-img', linkId: 'thumb-certidao-link' }
            ];

            let temDocumento = false;
            docs.forEach(d => {
                const el = document.getElementById(d.thumbId);
                const img = document.getElementById(d.imgId);
                const link = document.getElementById(d.linkId);
                // Tentar múltiplos nomes de campo (API nova e antiga)
                let base64 = null;
                for (const f of d.fields) { if (m[f]) { base64 = m[f]; break; } }
                if (base64 && base64.length > 10) {
                    const src = base64.startsWith('data:') ? base64 : `data:image/jpeg;base64,${base64}`;
                    if (img) img.src = src;
                    if (link) link.href = src;
                    if (el) el.style.display = 'flex';
                    temDocumento = true;
                } else {
                    if (el) el.style.display = 'none';
                }
            });

            const nenhumMsg = document.getElementById('docs-nenhum-msg');
            if (nenhumMsg) nenhumMsg.style.display = temDocumento ? 'none' : 'block';

            // Laudo médico
            const laudoEl = document.getElementById('thumb-laudo');
            const laudoImg = document.getElementById('thumb-laudo-img');
            const laudoLink = document.getElementById('thumb-laudo-link');
            const laudoBase64 = m.anexo_parecer_base64 || m.parecer_medico;
            const laudoNenhumMsg = document.getElementById('laudo-nenhum-msg');

            if (laudoBase64 && laudoBase64.length > 10) {
                const src = laudoBase64.startsWith('data:') ? laudoBase64 : `data:image/jpeg;base64,${laudoBase64}`;
                if (laudoImg) laudoImg.src = src;
                if (laudoLink) laudoLink.href = src;
                if (laudoEl) laudoEl.style.display = 'flex';
                if (laudoNenhumMsg) laudoNenhumMsg.style.display = 'none';
            } else {
                if (laudoEl) laudoEl.style.display = 'none';
                if (laudoNenhumMsg) laudoNenhumMsg.style.display = 'block';
            }
        }

        // ========== FILTRO COMBINADO DE MATRÍCULAS ==========
        function filtrarMatriculas() {
            const filtroMatCpf = (document.getElementById('filter-matricula-cpf')?.value || '').toLowerCase().trim();
            const filtroNomeTurma = (document.getElementById('filter-nome-turma')?.value || '').toLowerCase().trim();
            const filtroAnoTipoStatus = (document.getElementById('filter-ano-tipo-status')?.value || '').toLowerCase().trim();

            const dadosFiltrados = matriculasData.filter(m => {
                // Critério 1: Matrícula ou CPF
                if (filtroMatCpf) {
                    const mat = (m.matricula || '').toString().toLowerCase();
                    const cpf = (m.cpf_aluno || m.cpf || '').toLowerCase();
                    const cpfFmt = formatarCPF(m.cpf_aluno || m.cpf || '').toLowerCase();
                    if (!mat.includes(filtroMatCpf) && !cpf.includes(filtroMatCpf) && !cpfFmt.includes(filtroMatCpf)) {
                        return false;
                    }
                }

                // Critério 2: Nome ou Turma
                if (filtroNomeTurma) {
                    const nome = (m.nome_aluno || m.nome || '').toLowerCase();
                    const turma = (m.turma || '').toLowerCase();
                    if (!nome.includes(filtroNomeTurma) && !turma.includes(filtroNomeTurma)) {
                        return false;
                    }
                }

                // Critério 3: Ano, Tipo ou Status
                if (filtroAnoTipoStatus) {
                    const ano = (m.ano_letivo || '').toString().toLowerCase();
                    const tipo = (m.tipo_matricula || m.tipo || '').toLowerCase();
                    const status = (m.status || '').toLowerCase();
                    const nivel = (m.nivel_atual || '').toLowerCase();
                    if (!ano.includes(filtroAnoTipoStatus) && !tipo.includes(filtroAnoTipoStatus) && !status.includes(filtroAnoTipoStatus) && !nivel.includes(filtroAnoTipoStatus)) {
                        return false;
                    }
                }

                return true;
            });

            renderizarTabelaMatriculas(dadosFiltrados, 'tbody-main-matriculas', null, 'main');
        }

        // ========== BUSCA EM TABELAS ==========
        function filterTable(inputId, tableId) {
            const input = document.getElementById(inputId);
            const filter = input.value.toLowerCase();
            const table = document.getElementById(tableId);
            const tr = table.getElementsByTagName('tr');

            for (let i = 1; i < tr.length; i++) {
                let displayRow = false;
                const td = tr[i].getElementsByTagName('td');

                for (let j = 0; j < td.length; j++) {
                    if (td[j]) {
                        const txtValue = td[j].textContent || td[j].innerText;
                        if (txtValue.toLowerCase().indexOf(filter) > -1) {
                            displayRow = true;
                            break;
                        }
                    }
                }
                tr[i].style.display = displayRow ? '' : 'none';
            }
        }

        // ========== MODAL E TABS ==========
        function openModal(id, isReadOnly = false) {
            const modal = document.getElementById(id);
            modal.classList.add('active');

            const forms = modal.querySelectorAll('form');
            forms.forEach(form => {
                if (isReadOnly) {
                    form.style.pointerEvents = 'none';
                    form.style.opacity = '0.9';
                } else {
                    form.style.pointerEvents = 'auto';
                    form.style.opacity = '1';
                }
            });

            const formElements = modal.querySelectorAll('input, select, textarea, button:not(.btn-close):not(.nav-tab)');
            formElements.forEach(el => {
                if (isReadOnly) {
                    el.tabIndex = -1;
                    if (el.type === 'checkbox' || el.type === 'radio' || el.tagName === 'SELECT' || el.type === 'file' || el.tagName === 'BUTTON') {
                        el.disabled = true;
                    } else {
                        el.readOnly = true;
                    }
                } else {
                    el.tabIndex = 0;
                    if (el.type === 'checkbox' || el.type === 'radio' || el.tagName === 'SELECT' || el.type === 'file' || el.tagName === 'BUTTON') {
                        el.disabled = false;
                    } else {
                        if (el.tagName === 'INPUT' && el.id === 'anoLetivo') {
                            el.readOnly = true;
                        } else {
                            el.readOnly = false;
                        }
                    }
                }
            });

            const footerBtns = modal.querySelectorAll('.modal-footer .btn');
            footerBtns.forEach(btn => {
                btn.style.display = isReadOnly ? 'none' : 'inline-flex';
            });
        }

        function closeModal(id) {
            document.getElementById(id).classList.remove('active');
        }

        function switchTab(btnElement, modalId) {
            const modal = document.getElementById(modalId);
            modal.querySelectorAll('.nav-tab').forEach(tb => tb.classList.remove('active'));
            modal.querySelectorAll('.tab-content').forEach(tc => tc.classList.remove('active'));
            btnElement.classList.add('active');
            const targetId = btnElement.getAttribute('data-tab');
            modal.querySelector('#' + targetId).classList.add('active');
        }

        // ========== INIT ==========
        document.addEventListener('DOMContentLoaded', () => {
            const navItems = document.querySelectorAll('.nav-item');
            const views = document.querySelectorAll('.view');
            const pageTitle = document.getElementById('current-page-title');

            const pageTitlesMap = {
                'view-inicio': 'Página inicial',
                'view-matriculas': 'Matrículas',
                'view-turmas': 'Turmas',
                'view-admin': 'Administração'
            };

            navItems.forEach(item => {
                item.addEventListener('click', (e) => {
                    e.preventDefault();
                    navItems.forEach(n => n.classList.remove('active'));
                    views.forEach(v => v.classList.remove('active'));
                    item.classList.add('active');
                    const targetId = item.getAttribute('data-target');
                    document.getElementById(targetId).classList.add('active');
                    pageTitle.textContent = pageTitlesMap[targetId];
                });
            });

            // Aplicar controle de acesso (RBAC)
            aplicarRBAC();

            // Carregar dados iniciais da API
            carregarMatriculas();
            carregarTurmas();
            carregarOpcoesTurmas();

            // Listener para consulta de aluno por CPF (blur = ao sair do campo)
            const cpfInput = document.getElementById('cpf');
            if (cpfInput) {
                cpfInput.addEventListener('blur', () => {
                    const val = cpfInput.value.replace(/\D/g, '');
                    if (val.length >= 11) {
                        consultarAlunoPorCPF(val);
                    }
                });
            }

            // Auto-preencher Modalidade de acordo com a Faixa Etária
            const selectFaixa = document.getElementById('turma_faixa_etaria');
            const selectModalidade = document.getElementById('turma_modalidade');
            if (selectFaixa && selectModalidade) {
                selectFaixa.addEventListener('change', () => {
                    const val = selectFaixa.value.toUpperCase();
                    if (val.includes('06 A 11')) {
                        setSelectOptionsMatch(selectModalidade, 'Infantil');
                    } else if (val.includes('12 A 17')) {
                        setSelectOptionsMatch(selectModalidade, 'Adolescente');
                    } else if (val.includes('18 A 49') || val.includes('50+')) {
                        setSelectOptionsMatch(selectModalidade, 'Adulto');
                    }
                });
            }
        });

        // Função auxiliar para selecionar opção compatível no select
        function setSelectOptionsMatch(selectEl, matchText) {
            if (!selectEl || !matchText) return;
            const textMatch = matchText.toUpperCase();
            for (let i = 0; i < selectEl.options.length; i++) {
                if (selectEl.options[i].text.toUpperCase().includes(textMatch) || selectEl.options[i].value.toUpperCase().includes(textMatch)) {
                    selectEl.selectedIndex = i;
                    return;
                }
            }
        }

        // ========== CARREGAR OPÇÕES DINÂMICAS PARA TURMAS ==========
        async function carregarOpcoesTurmas() {
            const endpoints = [
                { url: 'https://webhook-n8n-dev-conectarecife.recife.pe.gov.br/webhook/faixa_etaria', id: 'turma_faixa_etaria', key: 'faixa_etaria' },
                { url: 'https://webhook-n8n-dev-conectarecife.recife.pe.gov.br/webhook/modalidade_turmas', id: 'turma_modalidade', key: 'modalidade' },
                { url: 'https://webhook-n8n-dev-conectarecife.recife.pe.gov.br/webhook/dias_turmas', id: 'turma_dias', key: 'dias' },
                { url: 'https://webhook-n8n-dev-conectarecife.recife.pe.gov.br/webhook/professor', id: 'turma_professor', key: 'professor' },
                { url: 'https://webhook-n8n-dev-conectarecife.recife.pe.gov.br/webhook/sala', id: 'turma_sala', key: 'sala' },
                { url: 'https://webhook-n8n-dev-conectarecife.recife.pe.gov.br/webhook/horario_turmas', id: 'turma_horario', key: 'horario' }
            ];

            for (const config of endpoints) {
                const selectEl = document.getElementById(config.id);
                if (!selectEl) continue;

                try {
                    const response = await fetch(config.url);
                    if (!response.ok) throw new Error('Erro HTTP: ' + response.status);
                    const data = await response.json();

                    selectEl.innerHTML = '<option value="">Selecione...</option>';

                    // Se for faixa_etaria, aplicar a ordenação lógica solicitada
                    if (config.key === 'faixa_etaria') {
                        const faixaPriority = {
                            '06 A 11 ANOS': 1,
                            '12 A 17 ANOS': 2,
                            '18 A 49 ANOS': 3,
                            '50+': 4
                        };
                        data.sort((a, b) => {
                            const valA = (a[config.key] || '').toUpperCase().trim();
                            const valB = (b[config.key] || '').toUpperCase().trim();
                            const prioA = faixaPriority[valA] || 99;
                            const prioB = faixaPriority[valB] || 99;
                            return prioA - prioB;
                        });
                    } else if (config.key === 'horario') {
                        // Ordenar horários de forma ASC
                        data.sort((a, b) => {
                            const valA = (a[config.key] || '').trim();
                            const valB = (b[config.key] || '').trim();
                            return valA.localeCompare(valB);
                        });
                    }

                    data.forEach(item => {
                        if (item && item[config.key]) {
                            const opt = document.createElement('option');
                            opt.value = item[config.key];
                            opt.textContent = item[config.key];
                            selectEl.appendChild(opt);
                        }
                    });
                } catch (err) {
                    console.error('Erro ao carregar opções para ' + config.id, err);
                    selectEl.innerHTML = '<option value="">Erro ao carregar</option>';
                }
            }
        }


        // Toggle User Menu Dropdown
        function toggleUserMenu() {
            document.getElementById('userDropdown').classList.toggle('active');
        }

        // Fechar dropdown ao clicar fora
        window.addEventListener('click', function (e) {
            if (!e.target.closest('.user-menu')) {
                const dropdown = document.getElementById('userDropdown');
                if (dropdown && dropdown.classList.contains('active')) {
                    dropdown.classList.remove('active');
                }
            }
        });

        // ========== ADMINISTRA!ÒO ==========
        async function salvarPeriodosMatricula(btnElement) {
            const originalText = btnElement.innerHTML;
            btnElement.disabled = true;
            btnElement.innerHTML = '<i class="ph ph-spinner" style="font-size:1.25rem; animation: spin 1s linear infinite;"></i> Salvando...';

            const payload = {
                inicionovatos: document.getElementById('inicionovatos')?.value || '',
                iniciooficina: document.getElementById('iniciooficina')?.value || '',
                iniciorenovacao: document.getElementById('iniciorenovacao')?.value || '',
                responsavel: window.usuarioLogado || document.getElementById('user-name-display')?.textContent.trim() || 'Desconhecido',
                terminonovatos: document.getElementById('terminonovatos')?.value || '',
                terminooficina: document.getElementById('terminooficina')?.value || '',
                terminorenovacao: document.getElementById('terminorenovacao')?.value || ''
            };

            try {
                const response = await fetch('https://webhook-n8n-dev-conectarecife.recife.pe.gov.br/webhook/periodo-matricula-escolafrevo', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });

                if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

                alert('Períodos de matrícula salvos com sucesso!');
            } catch (error) {
                console.error('Erro ao salvar períodos:', error);
                alert('Erro na comunicação com o servidor ao salvar os períodos de matrícula.');
            } finally {
                btnElement.disabled = false;
                btnElement.innerHTML = originalText;
            }
        }

        // ========== EDI!ÒO DE MATRÍCULA ==========
        async function salvarMatricula(btnElement) {
            const originalText = btnElement.innerHTML;
            btnElement.disabled = true;
            btnElement.innerHTML = '<i class="ph ph-spinner" style="font-size:1.25rem; animation: spin 1s linear infinite;"></i> Salvando...';

            const getVal = id => document.getElementById(id)?.value || '';

            const fileToBase64 = file => new Promise((resolve, reject) => {
                if (!file) { resolve(null); return; }
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.onerror = error => reject(error);
                reader.readAsDataURL(file);
            });

            const getFileB64 = async (id, dictKey) => {
                const input = document.getElementById(id);
                if (input && input.files && input.files.length > 0) {
                    return await fileToBase64(input.files[0]);
                }
                if (window._currentMatriculaDocs && window._currentMatriculaDocs[dictKey]) {
                    return window._currentMatriculaDocs[dictKey];
                }
                return null;
            };

            const realizaAtv = getVal('realiza_atv_ask');
            const atvDesc = getVal('descreva_atv_ask');
            const atividadefisica = realizaAtv === 'Sim' && atvDesc ? atvDesc : realizaAtv;

            const usaMed = getVal('usa_mediamento_ask');
            const medDesc = getVal('descreva_medicamento_ask');
            const descreva_medicamento = usaMed === 'Sim' && medDesc ? medDesc : usaMed;

            const alergiaAsk = getVal('alergia_ask');
            const alergiaDesc = getVal('descreva_alergia_ask');
            const alergia = alergiaAsk === 'Sim' && alergiaDesc ? alergiaDesc : alergiaAsk;

            const idadeVal = parseInt(getVal('idade')) || 0;

            let cpfVal = getVal('cpf');
            let cpfRespVal = getVal('cpfresponsavel');
            if (cpfVal) cpfVal = formatarCPF(cpfVal);
            if (cpfRespVal) cpfRespVal = formatarCPF(cpfRespVal);

            const payload = {
                cpf_aluno: cpfVal,
                nome_aluno: getVal('nomeCompleto'),
                data_nasc: getVal('datanascimento'),
                idade: idadeVal,
                faixa_etaria: getVal('faixaetaria'),
                maior_idade_aluno: idadeVal >= 18 ? 'SIM' : 'NÒO',
                modalidade: getVal('modalidade'),
                cep: getVal('cep'),
                logradouro: getVal('logradouro'),
                numero: parseInt(getVal('numero')) || 0,
                complemento: getVal('complemento'),
                bairro: getVal('bairro'),
                cidade: getVal('cidade'),
                telefone: getVal('whatsapp'),
                email: getVal('email'),
                possuirg: getVal('possuirg'),
                racacor: getVal('racacor'),
                genero: getVal('genero'),
                nome_resp: getVal('nomeCompletoResponsavel'),
                cpf_responsavel: cpfRespVal,
                atividadefisica: atividadefisica,
                contraindicacao: getVal('contraindicacao_medica_ask'),
                descreva_contradi: getVal('qual_contraindicacao_ask'),
                descreva_medicamento: descreva_medicamento,
                alergia: alergia,
                p_pcd: getVal('pcd_ask'),
                tipodeficiencia: getVal('tipo_def_ask'),
                deficiencia: getVal('qual_deficiencia_ask'),
                nova_turma: getVal('turma'),
                ano: getVal('anoLetivo'),
                autorizacao_uso_imagem: 'SIM',
                status: 'ATIVA',

                // Arquivos em Base64
                rg_frente: await getFileB64('rg_frente', 'rg_frente'),
                rg_verso: await getFileB64('rg_verso', 'rg_verso'),
                certidao_nasc: await getFileB64('certidao_nasc', 'certidao_nasc'),
                parecer_medico: await getFileB64('parecer_medico', 'parecer_medico')
            };

            try {
                const response = await fetch('https://webhook-n8n-dev-conectarecife.recife.pe.gov.br/webhook/editingdata', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ data: payload })
                });

                if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

                showToast('Matrícula editada via painel com sucesso!', 'success');
                closeModal('modal-matricula');
                carregarMatriculas();
            } catch (error) {
                console.error('Erro ao atualizar matrícula:', error);
                showToast('Erro na comunicação com o servidor ao atualizar a matrícula.', 'error');
            } finally {
                btnElement.disabled = false;
                btnElement.innerHTML = originalText;
            }
        }
        // ========== CONFIRMA!ÒO RESUMO DA TURMA ==========
        function abrirResumoTurma() {
            const getVal = (id) => {
                const el = document.getElementById(id);
                // Para selects que vem da API, pegar o textContent da option selecionada se existir, senao value
                if (el && el.tagName === 'SELECT' && el.selectedIndex >= 0 && el.options[el.selectedIndex].value !== "") {
                    return el.options[el.selectedIndex].textContent;
                }
                return el ? el.value : '';
            };

            const tipoTurmaModEl = document.querySelector('input[name="tipo_turma_mod"]:checked');
            const tipoTurmaMod = tipoTurmaModEl ? tipoTurmaModEl.value : '';

            const numVagas = getVal('turma_num_vagas');
            const anoLetivo = getVal('turma_ano_letivo');
            const nivel = getVal('select-nivel');
            const modalidade = getVal('turma_modalidade');
            const faixa = getVal('turma_faixa_etaria');
            const dias = getVal('turma_dias');
            const horario = getVal('turma_horario');
            const sala = getVal('turma_sala');
            const professor = getVal('turma_professor');

            // Validação simples obrigatória
            if (!tipoTurmaMod || !anoLetivo || !numVagas || !faixa || !dias || !horario || !sala || !professor) {
                console.warn('Validação falhou. Valores atuais:', {
                    tipoTurmaMod, anoLetivo, numVagas, nivel, modalidade, faixa, dias, horario, sala, professor
                });
                showToast('Preencha todos os campos obrigatórios (*)', 'error');
                return;
            }

            // Concatenação customizada para o Nome da Turma
            // Ex: Nível - Modalidade | Dias - Horário | Prof. Nome
            const nomeConcat = `${nivel} - ${modalidade} | ${faixa} | ${dias} - ${horario}`;

            document.getElementById('resumo-nome-turma').textContent = nomeConcat;
            document.getElementById('resumo-vagas').textContent = numVagas;
            document.getElementById('resumo-tipo').textContent = tipoTurmaMod;
            document.getElementById('resumo-ano').textContent = anoLetivo;
            document.getElementById('resumo-nivel').textContent = nivel;
            document.getElementById('resumo-modalidade').textContent = modalidade;
            document.getElementById('resumo-faixa').textContent = faixa;
            document.getElementById('resumo-dias').textContent = dias;
            document.getElementById('resumo-horario').textContent = horario;
            document.getElementById('resumo-sala').textContent = sala;
            document.getElementById('resumo-professor').textContent = professor;

            openModal('modal-confirmacao-turma', false);
        }

        // ========== SALVAR TURMA ==========
        async function salvarTurma(btnElement) {
            const originalText = btnElement.innerHTML;
            btnElement.disabled = true;
            btnElement.innerHTML = '<i class="ph ph-spinner" style="font-size:1.25rem; animation: spin 1s linear infinite;"></i> Salvando...';

            const getVal = (id) => {
                const el = document.getElementById(id);
                return el ? el.value : '';
            };

            const tipoTurmaModEl = document.querySelector('input[name="tipo_turma_mod"]:checked');
            const tipoTurmaMod = tipoTurmaModEl ? tipoTurmaModEl.value : '';

            const numVagas = getVal('turma_num_vagas');

            const payload = {
                professor: getVal('turma_professor'),
                num_vagas: numVagas ? parseInt(numVagas) : 0,
                horario: getVal('turma_horario'),
                sala: getVal('turma_sala'),
                dias: getVal('turma_dias'),
                ano_letivo: getVal('turma_ano_letivo'),
                nivel: getVal('select-nivel'), // Usando ID existente no form
                faixa_etaria: getVal('turma_faixa_etaria'),
                tipo_turma: tipoTurmaMod,
                modalidade: getVal('turma_modalidade')
            };

            if (turmaSelecionadaId) {
                payload.id = parseInt(turmaSelecionadaId);
            }

            try {
                const response = await fetch('https://webhook-n8n-dev-conectarecife.recife.pe.gov.br/webhook/cadastrar-editar-turmas', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });

                if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

                showToast('Turma salva com sucesso!', 'success');
                closeModal('modal-turma');
                closeModal('modal-confirmacao-turma');
                if (typeof carregarTurmas === 'function') carregarTurmas();
            } catch (error) {
                console.error('Erro ao salvar turma:', error);
                showToast('Erro na comunicação com o servidor ao salvar a turma.', 'error');
            } finally {
                btnElement.disabled = false;
                btnElement.innerHTML = originalText;
            }
        }
    