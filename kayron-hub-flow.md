```mermaid
flowchart TD

%% =====================================================================
%% KAYRON HUB — FLUXO COMPLETO V4
%% AUTOMATION-FIRST + AI-ASSISTED + HUMAN SIGNATURE GATES
%% COM DESCRIÇÕES EXPANDIDAS E OBSERVAÇÕES LATERAIS
%% =====================================================================

START((Inicio))

%% =====================================================================
%% 0. GOVERNANÇA DA PLATAFORMA
%% =====================================================================

subgraph GOV["0. Governança da plataforma — existe antes do primeiro caso"]
direction TD

G1["AUTO — Registry de regras e versões<br/><br/>Mantém ContractVersion, TissVersionSet,<br/>PolicyVersion, tabelas de códigos e vigências.<br/>Toda regra usada em uma decisão precisa ter versão e effective_at."]:::auto
GN1["OBSERVAÇÃO<br/>Uma regra nova nunca altera um caso antigo.<br/>Casos históricos continuam vinculados à versão usada na época."]:::note
G1 -.-> GN1

G2["AUTO — IAM e autoridade<br/><br/>Resolve tenant, usuário, papel, delegação,<br/>credencial profissional, MFA e permissão para cada ação.<br/>Também verifica se a pessoa pode assinar aquele ato específico."]:::auto
GN2["OBSERVAÇÃO<br/>Autenticação responde quem é.<br/>Autorização responde o que pode fazer agora."]:::note
G2 -.-> GN2

G3["AUTO — Privacy Engine<br/><br/>Para cada tratamento resolve finalidade, base legal,<br/>dados mínimos necessários, retenção, destinatários<br/>e se transferência externa é permitida."]:::comp
GN3["OBSERVAÇÃO<br/>Consentimento não é a única base legal possível.<br/>A base precisa ser resolvida por finalidade e contexto."]:::note
G3 -.-> GN3

G4["AUTO — AI Governance Registry<br/><br/>Mantém AgentVersion, ModelRef, PromptVersion,<br/>ToolVersion, risco, finalidade permitida,<br/>dados permitidos e supervisor responsável."]:::comp
GN4["OBSERVAÇÃO<br/>Um agente não entra em produção só porque funciona.<br/>Precisa de avaliação, owner, versão e escopo permitido."]:::note
G4 -.-> GN4

G5["AUTO — AI Gateway<br/><br/>É a única porta entre agentes e dados/tools.<br/>Bloqueia modelo, tool, escopo ou dado não autorizado.<br/>Registra toda chamada para auditoria."]:::comp
GN5["OBSERVAÇÃO<br/>Agente não acessa banco ou serviço diretamente.<br/>Tudo passa por políticas no gateway."]:::note
G5 -.-> GN5

G6["AUTO — Audit Trail<br/><br/>Registra eventos append-only com ator, data/hora,<br/>hash, trace_id, versões de regra, assinatura<br/>e vínculo entre Proposal, Decision e resultado."]:::auto
GN6["OBSERVAÇÃO<br/>Correção gera novo evento.<br/>Nunca reescrever ou apagar o evento anterior."]:::note
G6 -.-> GN6

G7["AUTO — SLA Engine<br/><br/>Cria timers, lembretes, escalonamentos,<br/>prioridades e BreachEvents.<br/>Prazo vencido nunca aprova, nega ou paga automaticamente."]:::auto
GN7["OBSERVAÇÃO<br/>Timeout gera escalonamento operacional.<br/>Não gera decisão jurídica, clínica ou financeira."]:::note
G7 -.-> GN7

G1 --> G2 --> G3 --> G4 --> G5 --> G6 --> G7
end

START --> G1


%% =====================================================================
%% 1. PADRÃO UNIVERSAL DE APROVAÇÃO
%% =====================================================================

subgraph SIGNPAT["1. Padrão universal — máquina prepara; humano assume a responsabilidade"]
direction LR

SP1["AUTO/IA — Preparar ApprovalPackage<br/><br/>Pacote contém resumo, dados, documentos,<br/>evidências, divergências, alertas<br/>e rascunho do ato que será revisado."]:::auto

SP2["AUTO — Validar objetivamente<br/><br/>Confere schema, versão, regra, vigência,<br/>identidade, autoridade, documentos<br/>e pré-condições determinísticas."]:::auto

SP3["HUMANO — Revisar em tela simples<br/><br/>Vê apenas o que precisa decidir,<br/>com link para evidências e diferenças.<br/>Não precisa reconstruir o caso manualmente."]:::human

SP4{"HUMANO — Aprovar?"}:::human

SP5["HUMANO — Corrigir ou rejeitar<br/><br/>Altera somente os campos necessários<br/>ou registra motivo da rejeição.<br/>A versão anterior permanece intacta."]:::human

SP6["HUMANO — Assinar digitalmente<br/><br/>Assinatura ocorre somente após revisão.<br/>Nenhum agente ou serviço assina em nome do usuário."]:::human

SP7["AUTO — Verificar assinatura<br/><br/>Confere identidade, autoridade, integridade,<br/>certificado/credencial, timestamp<br/>e vincula assinatura ao conteúdo exato."]:::auto

SP8["AUTO — Criar Decision/Snapshot<br/><br/>Persistir resultado imutável e<br/>continuar o workflow automaticamente."]:::auto

SPN1["OBSERVAÇÃO<br/>Este padrão se repete para médico,<br/>hospital, operadora, fornecedor e financeiro."]:::note
SP1 -.-> SPN1

SP1 --> SP2 --> SP3 --> SP4
SP4 -->|Não| SP5
SP5 --> SP1
SP4 -->|Sim| SP6 --> SP7 --> SP8
end


%% =====================================================================
%% 2. ABERTURA DO CASO
%% =====================================================================

G7 --> A1["AUTO — Criar caso cirúrgico<br/><br/>Gera guide_id, trace_id e EvidenceBundle inicial.<br/>Define tenant, paciente, hospital responsável<br/>e contexto temporal do caso."]:::auto
AN1["OBSERVAÇÃO<br/>guide_id identifica o caso de negócio.<br/>trace_id correlaciona chamadas técnicas, eventos e integrações."]:::note
A1 -.-> AN1

A1 --> A2["AUTO — Importar dados existentes<br/><br/>Busca cadastro, plano, médico, hospital,<br/>documentos e dados já disponíveis em sistemas integrados.<br/>Evita solicitar novamente o que o ecossistema já possui."]:::auto
AN2["OBSERVAÇÃO<br/>O Kayron não deve transformar o usuário em digitador.<br/>Primeiro tenta importar; só depois pede complemento."]:::note
A2 -.-> AN2

A2 --> A3["AUTO — Gate LGPD do caso<br/><br/>Resolve a finalidade deste processamento,<br/>base legal aplicável, dados mínimos permitidos<br/>e destinatários autorizados."]:::comp
A3 --> A4{"Tratamento permitido para esta finalidade?"}:::comp

A4 -->|Não| A5["AUTO — Bloquear apenas a finalidade irregular<br/><br/>Cria PrivacyReviewTask com motivo objetivo,<br/>sem apagar o caso nem impedir atividades permitidas."]:::comp
A5 --> A6["HUMANO — Privacidade/Jurídico resolve exceção<br/><br/>Valida base, finalidade, contrato ou necessidade de ajuste.<br/>Depois publica decisão documentada."]:::human
A6 --> A3

A4 -->|Sim| A7["AUTO — Transparência sobre IA<br/><br/>Mostra onde IA pode auxiliar,<br/>o que ela faz e quem continua responsável.<br/>Registra preferência/recusa quando aplicável."]:::comp
AN3["OBSERVAÇÃO<br/>Recusa ao uso de IA não significa recusa ao atendimento.<br/>O sistema deve ter fallback sem agente."]:::note
A7 -.-> AN3

A7 --> A8{"IA permitida para esta capacidade?"}:::comp

A8 -->|Não| A9["AUTO — Fallback sem IA<br/><br/>Mantém automações determinísticas e revisão humana.<br/>O processo continua sem bloquear o paciente."]:::auto

A8 -->|Sim| A10["AUTO — Habilitar agentes autorizados<br/><br/>Somente agentes e tools permitidos para esta finalidade,<br/>tenant e classe de dado podem ser usados."]:::auto

A9 --> E0
A10 --> E0

E0{"AUTO — Caso é urgência/emergência?"}:::auto


%% =====================================================================
%% 3. URGÊNCIA / EMERGÊNCIA
%% =====================================================================

E0 -->|Sim| U1["HUMANO — Atender o paciente imediatamente<br/><br/>Assistência clínica tem prioridade.<br/>Etapas administrativas não podem atrasar cuidado urgente."]:::human
UN1["OBSERVAÇÃO<br/>O Kayron registra a exceção administrativa,<br/>mas nunca impede o atendimento emergencial."]:::note
U1 -.-> UN1

U1 --> U2["AUTO — Criar EmergencyExceptionRecord<br/><br/>Captura ator, data/hora, motivo,<br/>etapas não realizadas previamente<br/>e o que precisará ser regularizado depois."]:::auto

U2 --> U3["HUMANO — Realizar atendimento/cirurgia<br/><br/>Equipe executa o cuidado necessário<br/>e produz registros clínicos normais do procedimento."]:::human

U3 --> U4["AUTO — Importar fatos do atendimento<br/><br/>Busca documentos produzidos,<br/>materiais movimentados, tempos, equipe<br/>e demais registros disponíveis."]:::auto

U4 --> AIU["AGENTE IA — EmergencyRegularizationAgent<br/><br/>Organiza o que ocorreu, identifica documentos faltantes<br/>e monta rascunho da regularização retrospectiva.<br/>Não inventa documento e não autoriza retroativamente."]:::ai
AIU --> U5["PROPOSAL — Regularização retrospectiva<br/><br/>Lista fatos conhecidos, evidências existentes,<br/>pendências e itens que dependem de validação humana."]:::proposal

U5 --> U6["AUTO — Aplicar regras objetivas<br/><br/>Verifica elegibilidade as-of evento,<br/>contrato, regra de urgência e documentos mínimos."]:::auto
U6 --> U7{"Existe pendência que exige autoridade humana?"}:::auto

U7 -->|Não| U8["AUTO — Criar RegularizationSnapshot<br/><br/>Fecha a regularização documental<br/>e libera o fluxo para fechamento assistencial."]:::auto

U7 -->|Sim| U9["AUTO — Criar RegularizationApprovalPackage<br/><br/>Mostra somente as exceções que precisam de decisão<br/>ou assinatura de médico/hospital."]:::auto
U9 --> U10["HUMANO — Revisar, corrigir e assinar<br/><br/>Responsável valida a exceção,<br/>corrige se necessário e assume o ato."]:::human
U10 --> U11["AUTO — Validar assinatura e fechar regularização."]:::auto

U8 --> POST0
U11 --> POST0


%% =====================================================================
%% 4. SOLICITAÇÃO CIRÚRGICA ELETIVA
%% =====================================================================

E0 -->|Não| R0["AUTO — Abrir DraftRequest<br/><br/>Pré-carrega paciente, médico, hospital,<br/>dados do plano e documentos já disponíveis."]:::auto

R0 --> AI1["AGENTE IA 1 — RequestDraftAgent<br/><br/>Lê pedido, exames, laudos e histórico permitido.<br/>Extrai dados e monta rascunho estruturado da solicitação.<br/>Não cria diagnóstico, tratamento ou indicação clínica."]:::ai
R0 -.-> RN1["OBSERVAÇÃO<br/>O agente deve citar de onde veio cada campo importante.<br/>Campo sem evidência vira pendência, não invenção."]:::note

AI1 --> R1["PROPOSAL — Solicitação cirúrgica<br/><br/>Campos sugeridos + evidência de origem +<br/>confidence_score + campos faltantes + divergências."]:::proposal

R1 --> R2["AUTO — Validação estrutural<br/><br/>Confere campos obrigatórios, TISS/TUSS,<br/>formatos, duplicidade, datas e consistência objetiva."]:::auto

R2 --> R3{"Rascunho tecnicamente completo?"}:::auto

R3 -->|Não| R4["AUTO — Tentar completar sozinho<br/><br/>Busca documentos em integrações autorizadas,<br/>repositórios do caso e dados já cadastrados."]:::auto
R4 --> R5{"Documento encontrado?"}:::auto

R5 -->|Sim| R2
R5 -->|Não| R6["AUTO — Solicitar somente o que falta<br/><br/>Cria tarefa objetiva, notifica responsável<br/>e acompanha prazo automaticamente."]:::auto
R6 --> R7["HUMANO — Enviar/corrigir apenas o item faltante."]:::human
R7 --> R8["AUTO — Criar DraftRequest vN+1<br/>sem alterar versão anterior."]:::auto
R8 --> R2

R3 -->|Sim| R9["AUTO — Criar MedicalRequestApprovalPackage<br/><br/>Tela mostra resumo do pedido,<br/>campos extraídos, evidências e alertas."]:::auto

R9 --> R10["HUMANO — Médico revisar<br/><br/>Médico lê o rascunho,<br/>corrige somente o necessário<br/>e confirma se representa sua intenção clínica."]:::human
R10 --> R11{"Médico aprova?"}:::human

R11 -->|Não| R12["HUMANO — Corrigir campos necessários."]:::human
R12 --> R13["AUTO — Criar nova versão do rascunho."]:::auto
R13 --> R2

R11 -->|Sim| R14["HUMANO — Médico assinar pedido."]:::human
RN2["OBSERVAÇÃO<br/>O médico não assina a IA.<br/>Assina o conteúdo final que revisou."]:::note
R14 -.-> RN2

R14 --> R15["AUTO — Validar CRM, autoridade,<br/>assinatura, conteúdo e integridade."]:::auto
R15 --> R16["AUTO — Criar RequestSnapshot imutável."]:::auto


%% =====================================================================
%% 5. APROVAÇÃO HOSPITALAR
%% =====================================================================

R16 --> AI2["AGENTE IA 2 — HospitalApprovalPrepAgent<br/><br/>Lê solicitação e regras internas do hospital.<br/>Monta resumo, pendências, riscos operacionais<br/>e pontos que precisam de decisão humana."]:::ai

AI2 --> H1["PROPOSAL — Aprovação hospitalar<br/><br/>Sugestão estruturada com<br/>PASS / WARNING / BLOCKING e evidências."]:::proposal

H1 --> H2["AUTO — Aplicar regras internas objetivas<br/><br/>Confere documentação, credenciais,<br/>requisitos administrativos e políticas vigentes."]:::auto

H2 --> H3["AUTO — Criar HospitalApprovalPackage<br/><br/>Hospital recebe tela pronta com<br/>resumo, alertas e links para evidências."]:::auto

H3 --> H4["HUMANO — Hospital revisar<br/><br/>Representante apenas lê,<br/>corrige/rejeita ou aprova.<br/>Não precisa remontar o caso."]:::human
H4 --> H5{"Hospital aprova?"}:::human

H5 -->|Não| H6["HUMANO — Registrar motivo/correção necessária."]:::human
H6 --> H7["AUTO — Criar nova versão<br/>e enviar pendência ao ator correto."]:::auto
H7 --> R0

H5 -->|Sim| H8["HUMANO — Hospital assinar aprovação."]:::human
H8 --> H9["AUTO — Validar assinatura<br/>e criar HospitalApprovalSnapshot."]:::auto

H9 --> P0["AUTO — Iniciar tarefas paralelas."]:::auto


%% =====================================================================
%% 6. PREPARAÇÃO PARALELA
%% =====================================================================

P0 --> EL0["AUTO — Elegibilidade<br/><br/>Consulta vínculo, vigência e regras objetivas<br/>na data relevante do caso."]:::auto

P0 --> AD0["AUTO/IA — Dossiê de autorização<br/><br/>Prepara documentação e evidências<br/>para envio à operadora."]:::auto

P0 --> AG0["AUTO — Agenda provisória<br/><br/>Busca opções de sala, equipe e data,<br/>mas ainda não confirma cirurgia."]:::auto

P0 --> OP0{"AUTO — Caso precisa de OPME?"}:::auto

EL0 --> EL1["AUTO — Criar EligibilitySnapshot<br/><br/>Registra fonte consultada, data/hora,<br/>resultado e versão das regras aplicadas."]:::auto

AD0 --> AI3["AGENTE IA 3 — AuthorizationDossierAgent<br/><br/>Busca e organiza documentos,<br/>evidências clínicas permitidas e pendências.<br/>Não decide cobertura ou autorização."]:::ai

AI3 --> AD1["PROPOSAL — AuthorizationDossier<br/><br/>Dossiê sugerido + checklist preenchido<br/>+ documentos faltantes + evidências citadas."]:::proposal

AD1 --> AD2["AUTO — Validar checklist<br/><br/>Confere documentos, vigência, assinatura,<br/>formato e requisitos objetivos."]:::auto

AD2 --> AD3{"Dossiê completo?"}:::auto

AD3 -->|Não| AD4["AUTO — Buscar faltas automaticamente<br/>e solicitar apenas o que não foi encontrado."]:::auto
AD4 --> AD0

AD3 -->|Sim| AD5["AUTO — Criar AuthorizationDossierSnapshot."]:::auto

AG0 --> AG1["AUTO — Consultar disponibilidade<br/><br/>Cruza sala, equipe, recursos e datas<br/>sem criar compromisso definitivo."]:::auto
AG1 --> AG2["AUTO — Criar AgendaOptions<br/>com status PROVISIONAL."]:::auto
AGN1["OBSERVAÇÃO<br/>Agenda provisória é apenas planejamento.<br/>Nunca habilita cirurgia sozinha."]:::note
AG2 -.-> AGN1

OP0 -->|Não| OPEND["AUTO — Registrar OPME_NOT_REQUIRED."]:::auto


%% =====================================================================
%% 7. OPME
%% =====================================================================

OP0 -->|Sim| AI4["AGENTE IA 4 — OpmeRequirementDraftAgent<br/><br/>Usa o pedido médico assinado para<br/>rascunhar requisitos técnicos do material.<br/>Não escolhe produto nem define indicação clínica."]:::ai

AI4 --> O1["PROPOSAL — Requisitos OPME<br/><br/>Características técnicas sugeridas,<br/>fontes e pontos de dúvida."]:::proposal

O1 --> O2["AUTO — Criar OpmeRequirementApprovalPackage."]:::auto
O2 --> O3["HUMANO — Médico revisar requisitos<br/><br/>Corrige se necessário e confirma<br/>o que o material precisa atender clinicamente."]:::human
O3 --> O4{"Médico aprova?"}:::human

O4 -->|Não| O5["HUMANO — Corrigir requisitos."]:::human
O5 --> O1

O4 -->|Sim| O6["HUMANO — Médico assinar requisitos."]:::human
O6 --> O7["AUTO — Abrir QuoteRequest<br/><br/>Seleciona fornecedores habilitados<br/>e envia convite automaticamente."]:::auto

O7 --> O8["AUTO — Importar catálogo/preço/documentos<br/><br/>Quando integração existir,<br/>pré-carrega dados do fornecedor."]:::auto

O8 --> AI5["AGENTE IA 5 — SupplierQuoteDraftAgent<br/><br/>Estrutura catálogo, preço, prazo e documentos<br/>em formato padrão do Kayron.<br/>Não inventa preço nem condição comercial."]:::ai

AI5 --> O9["PROPOSAL — SupplierQuote<br/><br/>Cotação estruturada para revisão do fornecedor."]:::proposal

O9 --> O10["AUTO — Validar proposta<br/><br/>Confere campos, documentos, validade,<br/>cadastro do produto e consistência do preço informado."]:::auto

O10 --> O11["HUMANO — Fornecedor revisar<br/><br/>Fornecedor confere produto, preço, prazo,<br/>condições e documentos."]:::human
O11 --> O12{"Fornecedor confirma?"}:::human

O12 -->|Não| O13["HUMANO — Corrigir cotação."]:::human
O13 --> O9

O12 -->|Sim| O14["HUMANO — Fornecedor assinar SupplierQuote."]:::human
O14 --> O15["AUTO — Receber e versionar cotações<br/>até a janela de cotação encerrar."]:::auto

O15 --> AI6["AGENTE IA 6 — OpmeComparisonAgent<br/><br/>Normaliza propostas e compara preço, prazo,<br/>documentação e requisitos técnicos.<br/>Não escolhe vencedor e não decide equivalência clínica."]:::ai

AI6 --> O16["PROPOSAL — Comparativo OPME<br/><br/>Tabela normalizada + diferenças + alertas<br/>+ documentos faltantes."]:::proposal

O16 --> O17["AUTO — Filtrar somente invalidade objetiva<br/><br/>Elimina proposta apenas se regra determinística<br/>publicada a considerar inválida."]:::auto

O17 --> O18["AUTO — Criar ClinicalCompatibilityPackage<br/><br/>Médico recebe somente as opções<br/>que passaram pelos controles objetivos."]:::auto

O18 --> O19["HUMANO — Médico avaliar compatibilidade<br/><br/>Marca quais opções são clinicamente aceitáveis<br/>e registra justificativa quando necessário."]:::human
O19 --> O20["HUMANO — Médico assinar avaliação clínica."]:::human

O20 --> O21["AUTO — Criar CommercialSelectionPackage<br/><br/>Hospital vê somente opções clinicamente aceitas,<br/>com preço, prazo e condições."]:::auto

O21 --> O22["HUMANO — Hospital selecionar opção comercial."]:::human
O22 --> O23["HUMANO — Hospital + médico coassinar seleção."]:::human
ON1["OBSERVAÇÃO<br/>IA pode comparar.<br/>Escolha clínica e comercial final permanece humana."]:::note
O23 -.-> ON1

O23 --> O24["AUTO — Validar coassinaturas<br/>e criar QuoteSelectionSnapshot."]:::auto


%% =====================================================================
%% 8. READY CHECK PRÉ-AUTORIZAÇÃO
%% =====================================================================

EL1 --> J0
AD5 --> J0
AG2 --> J0
OPEND --> J0
O24 --> J0
H9 --> J0

J0["AUTO — PreAuthorizationReadinessEvaluator<br/><br/>Faz JOIN real entre aprovação hospitalar,<br/>elegibilidade, documentação, agenda provisória<br/>e OPME quando aplicável."]:::auto

J0 --> J1{"Todas as dependências obrigatórias estão prontas?"}:::auto

J1 -->|Não| J2["AUTO — Criar tarefas específicas<br/><br/>Cada pendência vai somente para o ator responsável,<br/>com motivo e SLA claros."]:::auto
J2 --> J3["AUTO — Lembrar/escalar<br/>sem bloquear outras atividades independentes."]:::auto
J3 --> J0

J1 -->|Sim| J4["AUTO — Criar AuthorizationSubmissionDraft."]:::auto


%% =====================================================================
%% 9. ENVIO PARA OPERADORA
%% =====================================================================

J4 --> AI7["AGENTE IA 7 — AuthorizationSubmissionReviewAgent<br/><br/>Faz revisão cognitiva final do pacote,<br/>aponta contradições, lacunas e evidências frágeis.<br/>Não decide autorização."]:::ai

AI7 --> PA1["PROPOSAL — Revisão pré-envio<br/><br/>Lista alertas e recomendações de correção."]:::proposal

PA1 --> PA2["AUTO — Validar tecnicamente<br/><br/>Confere schema TISS, anexos, assinaturas,<br/>vigência, formato e pré-condições."]:::auto

PA2 --> PA3{"Existe bloqueio objetivo?"}:::auto

PA3 -->|Sim| PA4["AUTO — Corrigir o que for mecânico<br/><br/>Formatação, transformação segura e inconsistência técnica<br/>podem ser corrigidas automaticamente."]:::auto

PA4 --> PA5{"Correção exige autoridade humana?"}:::auto
PA5 -->|Não| J0
PA5 -->|Sim| PA6["AUTO — Criar CorrectionApprovalPackage."]:::auto
PA6 --> PA7["HUMANO — Corrigir/confirmar apenas a exceção."]:::human
PA7 --> J0

PA3 -->|Não| PA8["AUTO — Enviar solicitação à operadora."]:::external
PA8 --> PA9["AUTO — Guardar payload exato, hash,<br/>versões, protocolo e data/hora."]:::auto

PA9 --> PA10["AUTO — Monitorar status e SLA."]:::auto
PA10 --> PA11{"Operadora pediu complemento?"}:::external

PA11 -->|Sim| PA12["AUTO — Interpretar pendência<br/>e procurar evidência existente no caso."]:::auto

PA12 --> PA13{"Sistema consegue responder apenas<br/>com fatos/documentos já existentes?"}:::auto

PA13 -->|Sim| PA14["AUTO — Criar Submission vN+1<br/>e reenviar conforme regra do canal."]:::auto
PA14 --> PA9

PA13 -->|Não| PA15["AUTO — Criar tarefa específica<br/>para o responsável correto."]:::auto
PA15 --> PA16["HUMANO — Corrigir/confirmar apenas o ponto pendente."]:::human
PA16 --> PA17["AUTO — Criar Submission vN+1 e reenviar."]:::auto
PA17 --> PA9

PA11 -->|Não| OA0["OPERADORA — Iniciar análise de autorização."]:::external


%% =====================================================================
%% 10. ANÁLISE DA OPERADORA
%% =====================================================================

OA0 --> OA1["AUTO — Carregar contexto objetivo<br/><br/>Contrato, elegibilidade, itens solicitados,<br/>documentos, autorização prévia e regras vigentes."]:::auto

OA1 --> AI8["AGENTE IA 8 — OperatorReviewDraftAgent<br/><br/>Monta rascunho item a item para o analista,<br/>com evidências, inconsistências e resumo.<br/>Não emite autorização ou negativa."]:::ai

AI8 --> OA2["PROPOSAL — Análise da operadora<br/><br/>Resultado sugerido por item + evidências + alertas."]:::proposal

OA2 --> OA3["AUTO — Executar checks administrativos<br/><br/>Cobertura contratual, elegibilidade,<br/>documentação e requisitos objetivos."]:::auto

OA3 --> OA4{"Existe questão técnico-assistencial?"}:::auto

OA4 -->|Não| OA5["AUTO — Criar OperatorDecisionPackage<br/><br/>Pacote administrativo pronto para revisão."]:::auto

OA4 -->|Sim| OA6["AUTO — Criar MedicalAuditPackage<br/><br/>Entrega ao médico auditor apenas<br/>evidências clínicas permitidas e relevantes."]:::auto

OA5 --> OA7["HUMANO — Analista da operadora revisar<br/><br/>Corrige ou confirma o resultado administrativo."]:::human

OA6 --> OA8["HUMANO — Médico auditor revisar<br/><br/>Analisa questão técnico-assistencial,<br/>corrige se necessário e assume responsabilidade clínica."]:::human

OA7 --> OA9{"Responsável aprova resultado final?"}:::human
OA8 --> OA9

OA9 -->|Não| OA10["HUMANO — Corrigir resultado ou justificativa."]:::human
OA10 --> OA5

OA9 -->|Sim| OA11["HUMANO — Assinar decisão."]:::human
OA11 --> OA12["AUTO — Validar assinatura e criar DecisionRecord."]:::auto

OA12 --> OA13{"Resultado da autorização?"}:::auto
OA13 -->|Total| AUT1["AUTO — AUTHORIZED."]:::auto
OA13 -->|Parcial| AUT2["AUTO — PARTIALLY_AUTHORIZED."]:::auto
OA13 -->|Negativa administrativa| AUT3["AUTO — DENIED_ADMINISTRATIVE."]:::auto
OA13 -->|Negativa clínica| AUT4["AUTO — DENIED_CLINICAL."]:::auto

AUT1 --> AUT5["AUTO — Criar AuthorizationSnapshot item a item."]:::auto
AUT2 --> AUT6["AUTO — Criar AuthorizationSnapshot item a item."]:::auto

AUT3 --> AI9
AUT4 --> AI9

AI9["AGENTE IA 9 — AuthorizationContestDraftAgent<br/><br/>Organiza motivo da negativa,<br/>busca evidências e prepara minuta de contestação.<br/>Não decide recorrer e não envia."]:::ai

AI9 --> AUT7["PROPOSAL — Contestação de autorização<br/><br/>Minuta + evidências citadas + pontos de divergência."]:::proposal

AUT7 --> AUT8["AUTO — Criar ContestationApprovalPackage."]:::auto
AUT8 --> AUT9["HUMANO — Hospital/médico revisar<br/><br/>Lê, corrige e decide se quer contestar."]:::human
AUT9 --> AUT10{"Contestar?"}:::human

AUT10 -->|Não| CLOSE_DENIED["AUTO — Encerrar apenas o escopo não autorizado."]:::auto

AUT10 -->|Sim| AUT11["HUMANO — Assinar contestação."]:::human
AUT11 --> AUT12["AUTO — Enviar nova rodada<br/>preservando a decisão anterior."]:::auto
AUT12 --> PA9

AUT6 --> AUT13{"Com o escopo parcial,<br/>a cirurgia continua segura?"}:::human

AUT13 -->|Não| AUT14["AUTO — Bloquear cirurgia<br/>e direcionar para contestação/revisão."]:::comp
AUT14 --> AUT8

AUT13 -->|Sim| READYAUTH["AUTO — AUTHORIZATION_READY_FOR_SURGERY."]:::auto
AUT5 --> READYAUTH


%% =====================================================================
%% 11. AGENDA
%% =====================================================================

READYAUTH --> SCH1["AUTO — Revalidar pré-condições<br/><br/>Autorização, elegibilidade,<br/>documentos, validade e recursos."]:::auto
AG2 --> SCH1

SCH1 --> SCH2["AUTO — Gerar melhores opções de agenda<br/><br/>Cruza disponibilidade de sala, equipe,<br/>recursos e restrições operacionais."]:::auto

SCH2 --> SCH3["AUTO — Criar ScheduleApprovalPackage<br/><br/>Hospital recebe opções ordenadas<br/>e motivo de indisponibilidade das demais."]:::auto

SCH3 --> SCH4["HUMANO — Hospital escolher/confirma agenda."]:::human
SCH4 --> SCH5["HUMANO — Assinar confirmação quando exigido."]:::human
SCH5 --> SCH6["AUTO — Criar SurgeryScheduleSnapshot<br/>e notificar todos os atores."]:::auto


%% =====================================================================
%% 12. LOGÍSTICA OPME
%% =====================================================================

SCH6 --> L0{"Existe OPME autorizada?"}:::auto

L0 -->|Não| LREADY["AUTO — MATERIALS_NOT_REQUIRED."]:::auto

L0 -->|Sim| L1["AUTO — Criar DispatchTask<br/><br/>Lista item, quantidade, lote esperado,<br/>prazo e documentos necessários."]:::auto

L1 --> L2["AUTO — Integrar estoque/logística do fornecedor<br/><br/>Importa dados automaticamente quando API estiver disponível."]:::auto

L2 --> L3["AUTO — Criar DispatchApprovalPackage."]:::auto
L3 --> L4["HUMANO — Fornecedor conferir e assinar despacho<br/><br/>Corrige remessa se necessário,<br/>mas não precisa preencher do zero."]:::human

L4 --> L5["AUTO — Acompanhar transporte, ETA e SLA."]:::auto

L5 --> L6["AUTO — Recebimento por QR/RFID<br/><br/>Importa produto, quantidade, lote,<br/>série, validade e horário."]:::auto

L6 --> L7["AUTO — Comparar recebido x selecionado x autorizado."]:::auto
L7 --> L8{"Conferência automática passou?"}:::auto

L8 -->|Sim| L9["AUTO — Criar ReceivingApprovalPackage."]:::auto
L9 --> L10["HUMANO — Hospital conferir fisicamente<br/>e assinar recebimento."]:::human
L10 --> LREADY["AUTO — MATERIALS_READY."]:::auto

L8 -->|Não| L11["AUTO — Bloquear apenas item divergente<br/>e explicar exatamente a diferença."]:::comp

L11 --> AI10["AGENTE IA 10 — OpmeSubstitutionDraftAgent<br/><br/>Monta opções documentalmente compatíveis<br/>e diferenças entre material esperado e disponível.<br/>Não declara equivalência clínica."]:::ai

AI10 --> L12["PROPOSAL — Substituição OPME<br/><br/>Opções + evidências + impactos objetivos."]:::proposal

L12 --> L13["HUMANO — Médico avaliar clinicamente<br/>e assinar opção aceitável."]:::human
L13 --> L14["HUMANO — Hospital aprovar condição comercial."]:::human
L14 --> L15{"Nova autorização é necessária?"}:::auto

L15 -->|Sim| L16["AUTO — Criar nova AuthorizationSubmission."]:::auto
L16 --> PA2

L15 -->|Não| L3


%% =====================================================================
%% 13. GATE DO DIA DA CIRURGIA
%% =====================================================================

LREADY --> DS0["AUTO — DayOfSurgeryGate<br/><br/>Última barreira antes da execução.<br/>Reavalia tudo que pode ter mudado desde o agendamento."]:::auto
SCH6 --> DS0

DS0 --> DS1["AUTO — Confirmar paciente, agenda<br/>e autorização vigente."]:::auto
DS1 --> DS2["AUTO — Conferir OPME, lote,<br/>série e validade."]:::auto
DS2 --> DS3["AUTO — Conferir documentos,<br/>assinaturas e credenciais."]:::auto
DS3 --> DS4["AUTO — Conferir ReviewTasks bloqueantes."]:::auto
DS4 --> DS5{"Todos os controles passaram?"}:::auto

DS5 -->|Não| DS6["AUTO — Bloquear início<br/>e mostrar motivo exato da falha."]:::comp
DS6 --> DS7["HUMANO — Responsável corrigir exceção."]:::human
DS7 --> DS0

DS5 -->|Sim| DS8["AUTO — Criar SurgicalReadyPackage."]:::auto
DS8 --> DS9["HUMANO — Equipe fazer confirmação final<br/>de identidade e segurança."]:::human
DS9 --> SURG0["AUTO — READY_FOR_SURGERY."]:::auto


%% =====================================================================
%% 14. CIRURGIA E REGISTRO
%% =====================================================================

SURG0 --> S1["HUMANO — Realizar cirurgia."]:::human

S1 --> S2["AUTO — Capturar eventos estruturados<br/><br/>QR/RFID, tempos, equipe,<br/>materiais e movimentações disponíveis."]:::auto

S2 --> S3["AUTO — Registrar materiais<br/><br/>Levados, abertos, utilizados,<br/>implantados, não usados e devolvidos."]:::auto

S3 --> AI11["AGENTE IA 11 — SurgicalRecordDraftAgent<br/><br/>Usa dados capturados e ditado permitido<br/>para preparar rascunho do relatório cirúrgico.<br/>Não cria fato clínico que não exista nas fontes."]:::ai

AI11 --> S4["PROPOSAL — Relatório cirúrgico<br/><br/>Texto estruturado com indicação da origem<br/>de cada informação relevante."]:::proposal

S4 --> S5["AUTO — Criar SurgicalRecordApprovalPackage."]:::auto
S5 --> S6["HUMANO — Médico revisar relatório<br/><br/>Lê, corrige e confirma se o documento<br/>representa corretamente o ato realizado."]:::human
S6 --> S7{"Médico aprova?"}:::human

S7 -->|Não| S8["HUMANO — Corrigir apenas fatos necessários."]:::human
S8 --> S4

S7 -->|Sim| S9["HUMANO — Médico assinar registro clínico."]:::human
S9 --> S10["AUTO — Validar assinatura e registrar<br/>uso de IA no prontuário quando aplicável."]:::comp

S10 --> S11["AUTO — Conciliar inventário<br/><br/>Autorizado x recebido x aberto x usado x devolvido."]:::auto
S11 --> S12{"Inventário fecha?"}:::auto

S12 -->|Sim| S13["AUTO — Criar InventorySnapshot<br/>e marcar estado AUDITED."]:::auto

S12 -->|Não| S14["AUTO — Criar InventoryExceptionPackage<br/><br/>Lista cada diferença, valor, item,<br/>responsável provável e ação necessária."]:::auto
S14 --> S15["HUMANO — Hospital resolver exceção<br/>e assinar ajuste/devolução quando exigido."]:::human
S15 --> S11

S13 --> POST0


%% =====================================================================
%% 15. FECHAMENTO ASSISTENCIAL
%% =====================================================================

POST0 --> AI12["AGENTE IA 12 — BillingEvidenceAgent<br/><br/>Organiza relatório, autorização, OPME,<br/>documentos e evidências por item faturável.<br/>Não decide o que deve ser cobrado."]:::ai

AI12 --> C1["PROPOSAL — EvidenceBundle por item<br/><br/>Evidências relacionadas + faltas + inconsistências."]:::proposal

C1 --> C2["AUTO — Validar vínculo<br/><br/>Confere se cada item realizado tem<br/>autorização, documentação e evidência compatível."]:::auto

C2 --> C3{"Falta alguma evidência?"}:::auto

C3 -->|Sim| C4["AUTO — Buscar automaticamente<br/>em sistemas integrados e repositórios autorizados."]:::auto
C4 --> C5{"Evidência encontrada?"}:::auto

C5 -->|Sim| C2

C5 -->|Não| C6["AUTO — Criar tarefa objetiva<br/>informando exatamente o documento faltante."]:::auto
C6 --> C7["HUMANO — Responsável enviar/corrigir<br/>somente a evidência ausente."]:::human
C7 --> C2

C3 -->|Não| C8["AUTO — READY_FOR_CHARGE_CAPTURE."]:::auto


%% =====================================================================
%% 16. FATURAMENTO
%% =====================================================================

C8 --> B1["AUTO — Criar ChargeItems<br/><br/>Cada item faturável nasce a partir<br/>do realizado documentado."]:::auto

B1 --> B2["AUTO — Vincular referências<br/><br/>AuthorizationItem + PerformedItem + EvidenceBundle."]:::auto

B2 --> B3["AUTO — Aplicar versões válidas<br/><br/>ContractVersion + TissVersionSet<br/>resolvidas pela data do fato."]:::auto

B3 --> AI13["AGENTE IA 13 — BillingDraftAgent<br/><br/>Sugere códigos/descrições e explica inconsistências.<br/>Não define preço fora do contrato<br/>e não envia cobrança."]:::ai

AI13 --> B4["PROPOSAL — BillingDraft<br/><br/>Itens sugeridos + códigos + evidências + alertas."]:::proposal

B4 --> B5["AUTO — Calcular valores<br/><br/>Quantidade, preço, pacote e total<br/>com aritmética decimal exata."]:::auto

B5 --> B6["AUTO — Criar BillingApprovalPackage<br/><br/>Faturista vê somente divergências,<br/>riscos e resumo financeiro."]:::auto

B6 --> B7["HUMANO — Faturista revisar<br/><br/>Corrige somente o necessário<br/>e confirma que a conta está pronta."]:::human
B7 --> B8{"Faturista aprova?"}:::human

B8 -->|Não| B9["HUMANO — Corrigir apenas item divergente."]:::human
B9 --> B4

B8 -->|Sim| B10["HUMANO — Assinar cobrança quando exigido."]:::human
B10 --> B11["AUTO — Validar assinatura<br/>e congelar BillingDraft aprovado."]:::auto


%% =====================================================================
%% 17. PREVENÇÃO DE GLOSA
%% =====================================================================

B11 --> DPE1["AUTO — DenialPreventionEngine<br/><br/>Executa todas as comparações objetivas<br/>antes de enviar a conta."]:::auto

DPE1 --> DPE2["AUTO — AUTORIZADO x REALIZADO."]:::auto
DPE2 --> DPE3["AUTO — REALIZADO x DOCUMENTADO."]:::auto
DPE3 --> DPE4["AUTO — DOCUMENTADO x FATURADO."]:::auto
DPE4 --> DPE5["AUTO — OPME ponta a ponta."]:::auto
DPE5 --> DPE6["AUTO — Contrato, preço, pacote e quantidade."]:::auto
DPE6 --> DPE7["AUTO — TISS/TUSS, schema, prazo e duplicidade."]:::auto

DPE7 --> AI14["AGENTE IA 14 — DenialRiskAgent<br/><br/>Explica riscos detectados pelas regras,<br/>localiza evidências e sugere correção.<br/>Não bloqueia conta por opinião própria."]:::ai

AI14 --> DPE8["PROPOSAL — Risco de glosa<br/><br/>Motivo provável + evidência + correção sugerida."]:::proposal

DPE8 --> DPE9{"Existe erro objetivo?"}:::auto

DPE9 -->|Sim correção mecânica segura| DPE10["AUTO — Corrigir automaticamente<br/><br/>Somente transformação/formatação sem alterar<br/>conteúdo clínico, comercial ou decisão humana."]:::auto
DPE10 --> DPE1

DPE9 -->|Sim exige autoridade humana| DPE11["AUTO — Criar CorrectionApprovalPackage<br/><br/>Mostra somente o item e a decisão necessária."]:::auto
DPE11 --> DPE12["HUMANO — Responsável revisar/corrigir/assinar."]:::human
DPE12 --> DPE1

DPE9 -->|Não| CLAIM1["AUTO — Criar ClaimSubmissionRound n1."]:::auto
DPEN1["OBSERVAÇÃO<br/>O objetivo não é IA prever tudo.<br/>Primeiro regras determinísticas; IA explica e prioriza."]:::note
DPE1 -.-> DPEN1


%% =====================================================================
%% 18. ENVIO DA COBRANÇA
%% =====================================================================

CLAIM1 --> CL1["AUTO — Gerar payload TISS<br/><br/>Monta mensagem, valida XSD,<br/>assinatura, hash e versão aplicável."]:::auto

CL1 --> CL2["AUTO — Enviar lote/cobrança."]:::external
CL2 --> CL3["AUTO — Guardar protocolo<br/>e acompanhar status técnico."]:::auto

CL3 --> CL4{"Operadora aceitou tecnicamente?"}:::external

CL4 -->|Não| CL5["AUTO — Registrar TechnicalRejection<br/><br/>Classificar motivo técnico.<br/>Isto NÃO é glosa."]:::auto

CL5 --> CL6{"Correção é mecânica e segura?"}:::auto

CL6 -->|Sim| CL7["AUTO — Corrigir e criar SubmissionRound nN+1."]:::auto
CL7 --> CL1

CL6 -->|Não| CL8["AUTO — Criar TechnicalCorrectionPackage."]:::auto
CL8 --> CL9["HUMANO — Faturista corrigir/confirmar somente o ponto."]:::human
CL9 --> CL10["AUTO — Nova rodada e reenvio."]:::auto
CL10 --> CL1

CL4 -->|Sim| ADJ0["AUTO — TECHNICALLY_ACCEPTED<br/>e aguardar adjudicação financeira."]:::auto


%% =====================================================================
%% 19. ADJUDICAÇÃO E GLOSA
%% =====================================================================

ADJ0 --> ADJ1["AUTO — Receber/consultar demonstrativo<br/><br/>Importa retorno da operadora<br/>pelo canal configurado."]:::external

ADJ1 --> ADJ2["AUTO — Normalizar retorno por ChargeItem."]:::auto

ADJ2 --> ADJ3["AUTO — Registrar valores por item<br/><br/>submitted_amount, processed_amount,<br/>allowed_amount, denied_amount e paid_amount."]:::auto

ADJ3 --> ADJ4{"denied_amount maior que 0?"}:::auto

ADJ4 -->|Não| REC0["AUTO — Criar/atualizar ReceivableItem<br/>para o valor liberado."]:::auto

ADJ4 -->|Sim| DEN1["AUTO — Criar DenialItem<br/>somente para o valor glosado."]:::auto
ADJN1["OBSERVAÇÃO<br/>Um mesmo item pode ser parcialmente liberado e parcialmente glosado.<br/>A glosa não precisa representar 100% do item."]:::note
DEN1 -.-> ADJN1


%% =====================================================================
%% 20. ANÁLISE E RECURSO DE GLOSA
%% =====================================================================

DEN1 --> DEN2["AUTO — Reconstruir timeline<br/><br/>Pedido, autorização, realizado,<br/>documentado, faturado e resposta da operadora."]:::auto

DEN2 --> DEN3["AUTO — Carregar contexto<br/><br/>Contrato, TISS/TUSS, autorização,<br/>evidências e reason_code da glosa."]:::auto

DEN3 --> AI15["AGENTE IA 15 — DenialRecoveryAgent<br/><br/>Analisa causa provável, preventabilidade,<br/>argumentos possíveis e prepara minuta do recurso.<br/>Não decide recorrer e não envia."]:::ai

AI15 --> DEN4["PROPOSAL — Análise + recurso<br/><br/>Causa-raiz sugerida + valor em disputa +<br/>evidências citadas + minuta de contestação."]:::proposal

DEN4 --> DEN5["AUTO — Validar objetivamente<br/><br/>Prazo, documentos, valores,<br/>referências e consistência da minuta."]:::auto

DEN5 --> DEN6{"Há prazo e fundamento para recurso?"}:::auto

DEN6 -->|Não| DEN7["AUTO — Criar DenialClosureApprovalPackage."]:::auto
DEN7 --> DEN8["HUMANO — Financeiro confirmar baixa/encerramento."]:::human
DEN8 --> DENFINAL["AUTO — DenialItem FINAL."]:::auto

DEN6 -->|Sim| AP1["AUTO — Criar AppealApprovalPackage<br/><br/>Minuta já pronta + evidências + prazo + valor."]:::auto

AP1 --> AP2["HUMANO — Hospital/médico responsável revisar<br/><br/>Lê, corrige somente se necessário<br/>e decide se quer recorrer."]:::human

AP2 --> AP3{"Recorrer?"}:::human

AP3 -->|Não| AP4["HUMANO — Registrar decisão de não recorrer."]:::human
AP4 --> DENFINAL

AP3 -->|Sim| AP5["HUMANO — Assinar recurso."]:::human
AP5 --> AP6["AUTO — Validar assinatura,<br/>gerar mensagem TISS e enviar."]:::auto

AP6 --> AP7["AUTO — Guardar protocolo,<br/>acompanhar status e SLA."]:::auto

AP7 --> AP8["AUTO — Receber resposta da operadora."]:::external
AP8 --> AP9{"Resultado?"}:::auto

AP9 -->|Acatado integral| AP10["AUTO — Criar ReceivableAdjustment integral."]:::auto
AP9 -->|Acatado parcial| AP11["AUTO — Ajustar valor revertido<br/>e manter saldo glosado."]:::auto
AP9 -->|Não acatado| AP12["AUTO — Manter saldo glosado."]:::auto

AP10 --> REC0
AP11 --> REC0

AP11 --> AP13{"Existe nova instância contratual?"}:::auto
AP12 --> AP13

AP13 -->|Não| DENFINAL

AP13 -->|Sim| AP14["AUTO — Criar AppealRound nN+1<br/>mantendo a rodada anterior imutável."]:::auto
AP14 --> AI15


%% =====================================================================
%% 21. PRAZOS
%% =====================================================================

CL3 --> SLA1["AUTO — ContractSlaTracker<br/><br/>Controla todos os prazos do caso<br/>a partir do contrato e regras vigentes."]:::auto
DEN1 --> SLA1
AP7 --> SLA1
REC0 --> SLA1

SLA1 --> SLA2["AUTO — payment_due_at."]:::auto
SLA1 --> SLA3["AUTO — appeal_due_at."]:::auto
SLA1 --> SLA4["AUTO — appeal_response_due_at."]:::auto
SLA1 --> SLA5["AUTO — reversed_denial_payment_due_at."]:::auto

SLA1 --> SLA6{"Prazo próximo ou vencido?"}:::auto

SLA6 -->|Próximo| SLA7["AUTO — Notificar e priorizar fila."]:::auto
SLA6 -->|Vencido| SLA8["AUTO — Criar BreachEvent + escalonamento."]:::auto
SLA6 -->|Normal| SLA9["AUTO — Continuar monitoramento."]:::auto
SLAN1["OBSERVAÇÃO<br/>Nenhum usuário precisa ficar olhando prazo.<br/>O sistema deve lembrar e escalar sozinho."]:::note
SLA1 -.-> SLAN1


%% =====================================================================
%% 22. PAGAMENTO E CONCILIAÇÃO
%% =====================================================================

REC0 --> PAY1["AUTO — ReceivableItem OPEN<br/><br/>Representa valor reconhecido,<br/>mas ainda não necessariamente recebido no banco."]:::auto

PAY1 --> PAY2["AUTO — Importar extrato/evento financeiro."]:::external

PAY2 --> PAY3["AUTO — Matching determinístico<br/><br/>Cruza operadora, protocolo,<br/>valor, data e referência financeira."]:::auto

PAY3 --> PAY4{"Matching exato?"}:::auto

PAY4 -->|Sim| PAY5["AUTO — Marcar SETTLED<br/>e criar BankSettlementEvidence."]:::auto

PAY4 -->|Não| AI16["AGENTE IA 16 — ReconciliationAssistant<br/><br/>Explica provável causa da divergência,<br/>agrupa evidências e sugere classificação.<br/>Não baixa ou libera dinheiro."]:::ai

AI16 --> PAY6["PROPOSAL — Conciliação financeira."]:::proposal

PAY6 --> PAY7["AUTO — Criar ReconciliationApprovalPackage."]:::auto

PAY7 --> PAY8["HUMANO — Financeiro revisar<br/><br/>Confirma classificação,<br/>corrige se necessário e assina decisão."]:::human

PAY8 --> PAY9["AUTO — Aplicar decisão financeira autorizada."]:::auto
PAY9 --> PAY3


%% =====================================================================
%% 23. FECHAMENTO FINANCEIRO
%% =====================================================================

DENFINAL --> FIN0
PAY5 --> FIN0

FIN0["AUTO — CaseFinancialClosureEvaluator<br/><br/>Verifica se cada ChargeItem,<br/>DenialItem, AppealCase e ReceivableItem<br/>está em estado terminal."]:::auto

FIN0 --> FIN1{"Todos os itens terminaram?"}:::auto

FIN1 -->|Não| FIN2["AUTO — Manter caso aberto<br/>e apontar exatamente qual item está pendente."]:::auto
FIN2 --> FIN0

FIN1 -->|Sim| FIN3["AUTO — Consolidar resultado final<br/><br/>Faturado, liberado, glosado,<br/>recursado, recuperado e recebido."]:::auto

FIN3 --> FIN4["AUTO — FINANCIAL_CLOSED."]:::auto


%% =====================================================================
%% 24. APRENDIZADO OPERACIONAL
%% =====================================================================

FIN4 --> INS1["AUTO — Publicar eventos analíticos<br/><br/>Somente dados necessários à finalidade,<br/>com minimização e controles de acesso."]:::comp

INS1 --> AI17["AGENTE IA 17 — DenialInsightsAgent<br/><br/>Encontra padrões de glosa, gargalos,<br/>causas recorrentes e oportunidades de prevenção.<br/>Não altera regra de produção."]:::ai

AI17 --> INS2["PROPOSAL — Melhoria de política/processo<br/><br/>Sugestão + impacto esperado + evidências."]:::proposal

INS2 --> INS3["AUTO — Simular nova política<br/><br/>Executa replay em casos históricos<br/>sem alterar os casos originais."]:::auto

INS3 --> INS4["AUTO — Criar PolicyApprovalPackage<br/><br/>Mostra métricas antes/depois,<br/>efeitos positivos e possíveis regressões."]:::auto

INS4 --> INS5["HUMANO — Dono da política revisar."]:::human
INS5 --> INS6{"Aprovar nova PolicyVersion?"}:::human

INS6 -->|Não| INS7["AUTO — Descartar Proposal."]:::auto

INS6 -->|Sim| INS8["HUMANO — Assinar publicação da política."]:::human
INS8 --> INS9["AUTO — Ativar PolicyVersion N+1<br/>somente a partir de effective_at."]:::auto
INSN1["OBSERVAÇÃO<br/>Aprendizado nunca significa reescrever o passado.<br/>Política nova vale para fatos novos."]:::note
INS9 -.-> INSN1


%% =====================================================================
%% 25. ENCERRAMENTO PROBATÓRIO
%% =====================================================================

FIN4 --> Z1["AUTO — Montar timeline completa<br/><br/>Ordena todos os eventos do caso<br/>com versões, atores, assinaturas e decisões."]:::auto
CLOSE_DENIED --> Z1

Z1 --> Z2["AUTO — Conferir completude probatória<br/><br/>Documentos, assinaturas, protocolos,<br/>snapshots, Proposal e DecisionRecords."]:::auto

Z2 --> Z3{"Existe lacuna probatória?"}:::auto

Z3 -->|Sim| Z4["AUTO — Criar EvidenceClosureTask<br/>somente para a lacuna identificada."]:::auto
Z4 --> Z5["HUMANO — Responsável complementar/corrigir."]:::human
Z5 --> Z2

Z3 -->|Não| Z6["AUTO — Gerar pacote probatório final<br/>e fechar Guide."]:::auto

FIM((Fim))
Z6 --> FIM


%% =====================================================================
%% 26. GATE PADRÃO PARA QUALQUER AGENTE
%% =====================================================================

subgraph AIGATE["26. Toda chamada de agente passa por este gate"]
direction TD

AI_G1["AUTO — Verificar se IA é permitida<br/><br/>Finalidade, tenant, paciente,<br/>capacidade e tipo de dado."]:::comp

AI_G2["AUTO — Minimizar contexto<br/><br/>Remove ou mascara tudo<br/>que o agente não precisa ver."]:::comp

AI_G3["AUTO — Expor somente tools permitidas<br/><br/>get / search / compute / propose.<br/>Sem commit, assinatura ou pagamento."]:::comp

AI_G4["AGENTE — Produzir somente Proposal<br/><br/>Saída deve conter evidências,<br/>confidence_score e expires_at."]:::ai

AI_G5["AUTO — Registrar execução<br/><br/>Modelo, prompt, tools, fontes,<br/>tokens, custo, trace e resultado."]:::auto

AI_G6["AUTO — Proibir commit direto<br/><br/>Proposal nunca altera estado crítico<br/>por conta própria."]:::comp

AI_G7["HUMANO — Quando houver responsabilidade<br/><br/>Ler, corrigir, rejeitar ou assinar."]:::human

AI_G8["AUTO — Após assinatura válida<br/><br/>Criar Decision/Snapshot<br/>e continuar workflow."]:::auto

AI_G1 --> AI_G2 --> AI_G3 --> AI_G4 --> AI_G5 --> AI_G6 --> AI_G7 --> AI_G8
end


%% =====================================================================
%% 27. RESUMO DO QUE CADA CAMADA FAZ
%% =====================================================================

subgraph MATRIX["27. Resumo operacional"]
direction TB

MX1["AUTOMAÇÃO TRADICIONAL<br/><br/>Integrações, importação, validação, versões,<br/>timers, notificações, TISS, matching, joins,<br/>retries, snapshots e trilha de auditoria."]:::auto

MX2["AGENTES DE IA<br/><br/>Rascunham, resumem, organizam documentos,<br/>comparam opções, explicam risco,<br/>montam análise e redigem minutas."]:::ai

MX3["HUMANOS<br/><br/>Médico, hospital, operadora, fornecedor e financeiro<br/>entram principalmente para revisar, corrigir,<br/>rejeitar ou assinar atos de responsabilidade."]:::human

MX4["NUNCA SÓ POR IA<br/><br/>Diagnóstico, prescrição, decisão clínica final,<br/>negativa clínica, assinatura, seleção final de OPME,<br/>mudança crítica de estado ou liberação de dinheiro."]:::comp

MX1 --> MX2 --> MX3 --> MX4
end


%% =====================================================================
%% ESTILOS
%% =====================================================================

classDef ai fill:#5b21b6,stroke:#d8b4fe,color:#ffffff,stroke-width:3px;
classDef proposal fill:#312e81,stroke:#a5b4fc,color:#ffffff,stroke-width:2px;
classDef human fill:#9a3412,stroke:#fdba74,color:#ffffff,stroke-width:3px;
classDef auto fill:#075985,stroke:#7dd3fc,color:#ffffff,stroke-width:2px;
classDef comp fill:#991b1b,stroke:#fca5a5,color:#ffffff,stroke-width:2px;
classDef external fill:#374151,stroke:#d1d5db,color:#ffffff,stroke-width:2px;
classDef note fill:#fef3c7,stroke:#d97706,color:#78350f,stroke-width:2px,stroke-dasharray: 6 4;
classDef terminal fill:#065f46,stroke:#6ee7b7,color:#ffffff,stroke-width:3px;
class START,FIM terminal;
```
