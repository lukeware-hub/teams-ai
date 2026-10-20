## Tipo

feature

## Objetivos

- A recepcionista marca consultas sem conflito de horário.

## Funcionalidades

- Marcar, remarcar e cancelar consultas.
- Confirmar a consulta pelo celular.
- O botão de marcar usa a cor #1d4ed8 com cantos de 8 px.

## Critérios de aceite

- AC-001 (smoke): Given que o horário está livre, when a recepcionista marca a consulta, then ela aparece na agenda.
- AC-002: Given uma consulta marcada, when o paciente confirma, then o status vira confirmado.

## Fora do escopo

- Cobrança e convênios.

## Dependências externas

- Nenhuma.

## Detalhes do bug

- (não se aplica)

## Tarefas

- Nenhuma.

## Decisões

### Fila de lembretes

Usar Redis para a fila de lembretes.
