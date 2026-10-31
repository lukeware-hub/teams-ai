# Problemas comuns e o que fazer

Perguntas que este texto responde: a execução parou, o que fazer, acabou a cota, o login expirou, a tarefa está bloqueada, o deploy falhou, não consigo criar a spec, o chat deu erro, o chat diz que não está registrado.

| O que você vê | O que significa | O que fazer |
|---|---|---|
| Pausada por cota | O limite de uso do Claude acabou | Nada: continua sozinha quando o limite renovar |
| Aguardando login | A sessão do Claude expirou | Entre de novo em Status do ambiente e clique em Retomar |
| Interrompida | O processo parou antes do fim | Clique em Retomar |
| Bloqueada | Uma tarefa não pôde ser concluída | Abra a execução, leia o motivo, corrija a causa e use Reprocessar |
| Deploy falhou | O serviço não subiu no seu computador | Abra a execução para ver o motivo e use Retomar ou Reprocessar |
| Verificação falhou | Testes ou verificações de qualidade não passaram | Abra a execução, veja qual verificação falhou |
| O chat mostrou um erro | Limite do Claude, sessão expirada ou resposta demorada | Leia a mensagem do aviso e clique em Tentar de novo; sua pergunta continua na caixa |
| O chat diz que não está registrado | A execução não gravou essa informação, ou ela está em outro registro | Abra a execução e leia o motivo; se ele não aparecer, reprocesse a spec para gerar o registro de novo |
| Não acho onde criar uma spec | O botão fica no cartão do projeto e na página do projeto | Veja "criar-spec" |
