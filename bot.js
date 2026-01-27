const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

// =================================================================================
// CONFIGURAÇÃO DOS SELETORES (AJUSTE CONFORME NECESSÁRIO)
// =================================================================================
// Como não temos acesso direto ao código fonte do Vision HTML5, usamos seletores
// baseados em texto (XPath) ou IDs genéricos que devem ser ajustados pelo usuário
// caso o sistema use IDs diferentes.
// =================================================================================

const CONFIG = {
    url_inicial: 'https://workspace.sisand.com.br/login',
    credentials: {
        user: '089.jeanp',
        pass: 'Dimasa1379@'
    },
    output_dir: path.join(__dirname, 'notas_extraidas'),
    selectors: {
        // Login
        login_user: "input[placeholder*='username'], input[placeholder*='usuário'], input[type='text']",
        login_pass: "input[type='password']",
        login_btn: "//button[contains(., 'Entrar') or contains(text(), 'Entrar')]",

        // Dashboard Principal
        // Procura um container que tenha "Vision Cloud" (mas não "2.0") e clica no link "Acessar" dentro dele
        btn_vision_cloud: "//div[contains(., 'Vision Cloud') and not(contains(., '2.0'))]//a[contains(., 'Acessar')]",

        // Navegação do Menu
        // Tenta encontrar o texto 'Faturamento' em qualquer elemento (span, div, a, li) que seja visível
        menu_faturamento: "//*[contains(text(), 'Faturamento')]", 
        menu_estoque: "//*[contains(text(), 'Estoque')]", 
        menu_entrada: "//*[contains(text(), 'Entrada')]",
        menu_lista_notas: "//*[contains(text(), 'Lista de Notas de Entrada') or contains(text(), 'Lista de Notas')]",
        
        // Sidebar / Filtros Laterais
        sidebar_em_transito: "//li[contains(., 'Em Trânsito')] | //a[contains(., 'Em Trânsito')] | //span[contains(., 'Em Trânsito')]",

        // Filtros
        filtro_origem_label: "//label[contains(., 'Origem')]", // Para encontrar o select próximo
        filtro_origem_select: "select[name*='Origem'], select[id*='Origem']", // Tentativa de achar o select por nome/id parcial
        
        // Grid Principal (Fila de Notas)
        // XPath para encontrar linhas da tabela que não sejam cabeçalho
        grid_linhas: "//table[contains(@id, 'Grid') or contains(@class, 'grid')]//tr[td]", 
        
        // Modal / Tela de Detalhes
        titulo_tela_detalhes: "//span[contains(., 'Nota Fiscal Entrada') or contains(h1, 'Nota Fiscal Entrada')]",
        aba_itens: "//a[contains(., 'Itens') or contains(@title, 'Itens')]",
        
        // Grid de Itens
        grid_itens_linhas: "//div[contains(@id, 'Itens')]//table//tr[td]",
        
        // Botão Fechar (Geralmente um X ou botão Fechar)
        botao_fechar: "//button[contains(., 'Fechar') or contains(@title, 'Fechar')] | //a[contains(@class, 'close')]"
    }
};

// Função de espera (sleep)
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
    console.log('=== INICIANDO BOT DE AUTOMAÇÃO VISION HTML5 ===');
    console.log('Contexto: Extração de Notas Fiscais de Entrada (Origem: Produto)');

    // 1. Iniciar Navegador
    const browser = await puppeteer.launch({
        headless: false, // Necessário ver o navegador
        defaultViewport: null,
        args: ['--start-maximized'] // Abrir maximizado para evitar problemas de layout
    });

    const page = await browser.newPage();

    // Conceder permissão de notificações para evitar popups
    const context = browser.defaultBrowserContext();
    try {
        await context.overridePermissions(CONFIG.url_inicial, ['notifications']);
        console.log('Permissões de notificação concedidas automaticamente.');
    } catch (e) {
        console.error('Não foi possível definir permissões (pode não ser suportado neste modo). Ignorando.');
    }

    console.log('Acessando página de login...');
    await page.goto(CONFIG.url_inicial, { waitUntil: 'networkidle2' });

    console.log('Realizando login automático...');
    
    // Preencher Usuário
    try {
        await page.waitForSelector(CONFIG.selectors.login_user, { timeout: 10000 });
        await page.type(CONFIG.selectors.login_user, CONFIG.credentials.user, { delay: 100 });
    } catch (e) {
        console.error('Erro ao encontrar campo de usuário. Tentando continuar ou verifique seletores.');
    }

    // Preencher Senha
    try {
        await page.type(CONFIG.selectors.login_pass, CONFIG.credentials.pass, { delay: 100 });
    } catch (e) {
        console.error('Erro ao encontrar campo de senha.');
    }

    // Clicar em Entrar
    try {
        const btnEntrar = await page.waitForSelector('xpath/' + CONFIG.selectors.login_btn, { timeout: 5000 });
        await btnEntrar.click();
        console.log('Botão Entrar clicado. Aguardando dashboard...');
        
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
        // Aguarda carregamento extra do dashboard
        await delay(3000);
    } catch (e) {
        console.error('Erro ao clicar em Entrar ou login falhou.');
    }

    console.log('\n--- Iniciando Fluxo de Automação ---');

    // ATUALIZAÇÃO DE REFERÊNCIA DE PÁGINA
    // O usuário pode ter navegado, aberto nova aba ou o login pode ter redirecionado.
    // Vamos pegar a aba mais recente (ativa) para garantir que não estamos usando um frame desconectado.
    const pages = await browser.pages();
    const activePage = pages[pages.length - 1]; // Pega a última aba (geralmente a ativa)
    
    // Se a página original mudou, atualizamos a referência. 
    // Usaremos 'page' como variável principal, mas apontando para a aba correta.
    const currentPage = activePage || page; 
    
    console.log(`Usando a aba com título: "${await currentPage.title()}"`);
    
    // Traz a página para frente
    await currentPage.bringToFront();

    try {
        // =================================================================
        // 0. Acessar Vision Cloud (Dashboard -> Vision Cloud)
        // =================================================================
        console.log('Procurando botão "Vision Cloud"...');
        try {
            const btnVision = await currentPage.waitForSelector('xpath/' + CONFIG.selectors.btn_vision_cloud, { timeout: 10000 });
            await btnVision.click();
            console.log('Clicou em Vision Cloud. Aguardando carregamento do sistema...');
            
            // Aguarda a nova aba ou redirecionamento
            await delay(5000); 
            
            // Atualiza novamente a página ativa, pois pode ter aberto nova aba
            const newPages = await browser.pages();
            const visionPage = newPages[newPages.length - 1];
            await visionPage.bringToFront();
            
            console.log(`Página atual: "${await visionPage.title()}"`);
            
            // Substitui currentPage por visionPage para o resto do fluxo
            Object.assign(currentPage, visionPage); 
            
            var targetPage = visionPage; // Nova variável para controlar a página alvo
            var menuFrameContext = visionPage; // Contexto padrão para menus

            console.log('Waiting for Vision Cloud main interface to finish loading');
            await delay(20000); // Wait generous time for heavy loading
            
            // DEBUG: Listar frames para diagnóstico
            const frames = targetPage.frames();
            console.log(`Frames detectados: ${frames.length}`);
            frames.forEach((f, i) => console.log(`Frame ${i}: Name="${f.name()}" URL="${f.url()}"`));

            // Check for CANVAS (Indicative of RDP/Citrix-like interface)
            const canvasCount = await targetPage.evaluate(() => document.querySelectorAll('canvas').length);
            if (canvasCount > 0) {
                console.warn(`AVISO: Detectados ${canvasCount} elementos CANVAS. O sistema pode ser uma transmissão de imagem (RDP). Seletores de texto podem não funcionar.`);
            }

            // Função helper para encontrar elemento em qualquer frame
            const findInFrames = async (xpath, timeout = 5000) => {
                for (const frame of targetPage.frames()) {
                    try {
                        // Check for canvas in this frame too
                        const hasCanvas = await frame.evaluate(() => document.querySelectorAll('canvas').length > 0);
                        if (hasCanvas) console.log(`Frame "${frame.name()}" contains CANVAS.`);

                        const el = await frame.waitForSelector('xpath/' + xpath, { timeout: timeout });
                        if (el) return { element: el, frame: frame };
                    } catch (e) { }
                }
                return null;
            };

            // Tenta encontrar o menu em qualquer frame
            try {
                console.log("Searching for 'Faturamento' in all frames...");
                const found = await findInFrames(CONFIG.selectors.menu_faturamento, 10000);
                if (found) {
                    console.log(`Menu 'Faturamento' found in frame: ${found.frame.name() || 'unnamed'}`);
                    menuFrameContext = found.frame;
                } else {
                    console.log("Menu 'Faturamento' not found in any frame during initial check.");
                }
            } catch (e) {
                console.log("Error searching frames: " + e.message);
            }

        } catch (e) {
            console.warn('Botão Vision Cloud não encontrado ou já estamos na tela correta. Continuando...');
            var targetPage = currentPage;
            var menuFrameContext = currentPage; // Fallback
        }

        // =================================================================
        // 1. Navegação Inicial: Faturamento -> Entrada -> Lista de Notas
        // =================================================================
        console.log("Searching for the 'Faturamento' (Billing) menu");
        
        // Tenta clicar em Faturamento
        console.log("Clicking on 'Faturamento'");
        // Usa o contexto do frame descoberto ou a página principal
        const menuFaturamento = await menuFrameContext.waitForSelector('xpath/' + CONFIG.selectors.menu_faturamento, { timeout: 30000 });
        await menuFaturamento.click();
        await delay(2000); // Pequena pausa para animações de menu

        // Tenta clicar em Entrada
        console.log("Searching for 'Entrada' (Inbound) option");
        // O menu dropdown pode abrir no mesmo frame ou em outro (menos provável, mas possível)
        // Vamos assumir mesmo frame por enquanto
        const menuEntrada = await menuFrameContext.waitForSelector('xpath/' + CONFIG.selectors.menu_entrada, { timeout: 10000 });
        await menuEntrada.click();
        await delay(1000);

        // Tenta clicar em Lista de Notas
        console.log("Opening 'Lista de Notas de Entrada' (Inbound Invoice List)");
        const menuLista = await menuFrameContext.waitForSelector('xpath/' + CONFIG.selectors.menu_lista_notas, { timeout: 10000 });
        await menuLista.click();
        
        console.log("Waiting for the invoice list screen to load");
        await targetPage.waitForNetworkIdle({ idleTime: 1000, timeout: 30000 }).catch(() => {});
        
        // Atualiza o contexto para o frame de conteúdo (pode ser diferente do menu)
        // Geralmente sistemas assim abrem a lista em um frame central
        // Vamos tentar redetectar o frame onde a lista apareceu se necessário, 
        // mas por enquanto usaremos targetPage ou menuFrameContext
        
        // =================================================================
        // 1.5. Sidebar: Em Trânsito
        // =================================================================
        console.log("Clicking on 'Em Trânsito' (In Transit) filter");
        try {
            const btnEmTransito = await targetPage.waitForSelector('xpath/' + CONFIG.selectors.sidebar_em_transito, { timeout: 15000 });
            await btnEmTransito.click();
            await delay(3000); // Aguarda filtro aplicar
        } catch (e) {
            console.error('Não foi possível clicar em "Em Trânsito". Verifique se a sidebar está visível.');
        }

        // =================================================================
        // 2. Filtro: Origem = Produto
        // =================================================================
        console.log("Selecting filter: Origem = Produto (Origin = Product)");
        
        // Tenta localizar o select de Origem. 
        // Estratégia: Encontrar label "Origem" e pegar o select associado ou próximo.
        // Se não funcionar pelo ID genérico, tentamos selecionar pelo texto da opção.
        
        // Vamos tentar encontrar o SELECT diretamente via JS se os seletores CSS falharem
        const filtroAplicado = await targetPage.evaluate(() => {
            // Procura todos os selects na página
            const selects = Array.from(document.querySelectorAll('select'));
            // Tenta achar um que tenha opções relacionadas a "Produto" ou label próximo
            for (const select of selects) {
                // Verifica label anterior
                const label = select.previousElementSibling || select.parentElement.previousElementSibling;
                if ((label && label.innerText.includes('Origem')) || select.name.includes('Origem') || select.id.includes('Origem')) {
                    // Encontrou o select. Agora busca a opção "Produto"
                    const options = Array.from(select.options);
                    const optionProduto = options.find(o => o.text.includes('Produto'));
                    if (optionProduto) {
                        select.value = optionProduto.value;
                        select.dispatchEvent(new Event('change', { bubbles: true })); // Dispara evento de mudança
                        return true;
                    }
                }
            }
            return false;
        });

        if (!filtroAplicado) {
            console.warn('AVISO: Não foi possível aplicar o filtro "Origem: Produto" automaticamente. Verifique se já está filtrado ou aplique manualmente agora.');
            // console.log('Pressione ENTER para continuar após conferir o filtro...');
            // await new Promise(resolve => process.stdin.once('data', resolve));
        } else {
            console.log("Waiting for filtered results to load");
            await delay(2000); // Tempo para o grid atualizar
            await targetPage.waitForNetworkIdle({ idleTime: 1000, timeout: 10000 }).catch(() => {});
        }

        // =================================================================
        // 3. Listagem e Iteração
        // =================================================================
        console.log('Analisando grade de notas...');

        // Captura todas as linhas da tabela principal
        // Nota: Elementos DOM (Handles) podem se perder ao navegar/abrir modais.
        // Estratégia: Contar o número de linhas e iterar por índice, re-buscando a cada volta.
        
        const totalLinhas = await targetPage.evaluate((selector) => {
            const result = document.evaluate(selector, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
            return result.snapshotLength;
        }, CONFIG.selectors.grid_linhas);

        console.log(`Encontradas ${totalLinhas} notas potenciais na visualização atual.`);

        // MODIFICAÇÃO: Processar apenas a primeira nota
        if (totalLinhas > 0) {
            let i = 0; // Primeira nota
            console.log("Opening the first invoice in the list");

            // Re-busca a linha a cada iteração para evitar "Element is not attached to the DOM"
            const dadosCabecalho = await targetPage.evaluate((selector, index) => {
                const result = document.evaluate(selector, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
                const row = result.snapshotItem(index);
                
                if (!row) return null;

                const cols = row.querySelectorAll('td');
                if (cols.length < 5) return null; // Linha inválida

                // Ajuste os índices das colunas conforme a grade real do Vision
                // Assumindo ordem comum: Checkbox, Ações, Número, Série, Fornecedor, Emissão, Valor...
                // Vou tentar pegar por texto ou assumir posições relativas. 
                // AQUI É UM PONTO CRÍTICO QUE PODE PRECISAR DE AJUSTE DO USUÁRIO
                
                return {
                    numero: cols[2]?.innerText?.trim() || "N/A", // Chute: coluna 3
                    serie: cols[3]?.innerText?.trim() || "N/A",  // Chute: coluna 4
                    fornecedor: cols[4]?.innerText?.trim() || "N/A",
                    emissao: cols[5]?.innerText?.trim() || "N/A",
                    valorTotal: cols[6]?.innerText?.trim() || "0,00"
                };
            }, CONFIG.selectors.grid_linhas, i);

            if (!dadosCabecalho || dadosCabecalho.numero === "N/A") {
                console.log('Linha inválida ou cabeçalho detectado. Tentando próxima...');
                // Se a primeira for inválida, poderíamos tentar a segunda, mas o requisito é "First invoice".
            } else {

                console.log(`Nota: ${dadosCabecalho.numero} | Fornecedor: ${dadosCabecalho.fornecedor}`);

                // 4. Abertura da Nota (Double Click)
                // Re-seleciona o elemento para clicar
                const handleLinha = await targetPage.evaluateHandle((selector, index) => {
                    const result = document.evaluate(selector, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
                    return result.snapshotItem(index);
                }, CONFIG.selectors.grid_linhas, i);

                if (handleLinha) {
                    // Double click para abrir
                    await handleLinha.click({ count: 2 });
                    
                    // 5. Aguardar carregamento da tela de detalhes
                    console.log("Invoice opened successfully");
                    try {
                        await targetPage.waitForSelector('xpath/' + CONFIG.selectors.titulo_tela_detalhes, { timeout: 8000 });
                        
                        // 6. Aba Itens
                        console.log('Acessando aba Itens...');
                        try {
                            const tabItens = await targetPage.waitForSelector('xpath/' + CONFIG.selectors.aba_itens, { timeout: 5000 });
                            await tabItens.click();
                            await delay(1000); // Espera grid renderizar
                        } catch (e) {
                            console.error('Não encontrou aba Itens. Verifique o seletor.');
                        }

                        // 7. Extração dos Itens
                        console.log('Extraindo itens...');
                        const itensExtraidos = await targetPage.evaluate((selector) => {
                            const linhas = [];
                            const result = document.evaluate(selector, document, null, XPathResult.ORDERED_NODE_ITERATOR_TYPE, null);
                            let row = result.iterateNext();
                            
                            let ordem = 1;
                            while (row) {
                                const cols = row.querySelectorAll('td');
                                if (cols.length > 5) {
                                    linhas.push({
                                        item: ordem++,
                                        codigo: cols[1]?.innerText?.trim() || null,
                                        descricao: cols[2]?.innerText?.trim() || null,
                                        quantidade: cols[3]?.innerText?.trim() || null,
                                        valorUnitario: cols[4]?.innerText?.trim() || null,
                                        valorTotalLiquido: cols[5]?.innerText?.trim() || null,
                                        icms: cols[6]?.innerText?.trim() || null,
                                        ipi: cols[7]?.innerText?.trim() || null,
                                        cfop: cols[8]?.innerText?.trim() || null
                                    });
                                }
                                row = result.iterateNext();
                            }
                            return linhas;
                        }, CONFIG.selectors.grid_itens_linhas);

                        // 8. Estruturação e Persistência
                        const notaCompleta = {
                            cabecalho: dadosCabecalho,
                            itens: itensExtraidos
                        };

                        const nomeArquivo = `NFE_${dadosCabecalho.numero.replace(/[^a-zA-Z0-9]/g, '')}.json`;
                        const caminhoArquivo = path.join(CONFIG.output_dir, nomeArquivo);

                        if (!fs.existsSync(CONFIG.output_dir)){
                            fs.mkdirSync(CONFIG.output_dir);
                        }
                        fs.writeFileSync(caminhoArquivo, JSON.stringify(notaCompleta, null, 2));
                        console.log(`Salvo: ${nomeArquivo} com ${itensExtraidos.length} itens.`);

                        // 9. Fechar Nota / Retornar
                        console.log('Fechando nota...');
                        const fechou = await targetPage.evaluate((selector) => {
                            const result = document.evaluate(selector, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                            const btn = result.singleNodeValue;
                            if (btn) {
                                btn.click();
                                return true;
                            }
                            return false;
                        }, CONFIG.selectors.botao_fechar);

                        if (!fechou) {
                            await targetPage.keyboard.press('Escape');
                        }

                    } catch (e) {
                        console.error('Erro ao abrir detalhe da nota ou timeout.', e);
                    }
                }
            }
        } else {
            console.log('Nenhuma nota encontrada na lista.');
        }

    } catch (error) {
        console.error('Erro fatal durante a execução:', error);
    } finally {
        console.log('\nProcesso finalizado.');
        // await browser.close(); // Comentado para deixar o usuário ver o resultado final se quiser
    }
})();
