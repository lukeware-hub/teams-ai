# Agenda Clínica

## Vision

Um serviço de API que permite à recepção de uma clínica pequena cadastrar pacientes, agendar consultas e avisar o paciente por e-mail antes da consulta.

## Personas

- Recepcionista: cadastra pacientes e marca, remarca ou cancela consultas pelo sistema da recepção.
- Paciente: recebe o lembrete por e-mail; não acessa o sistema.

## Constraints

- Dados pessoais seguem a LGPD: só nome, e-mail e telefone do paciente; nada de dados clínicos.
- Uma única clínica, com até 5 profissionais, e consultas de 30 minutos.
- Horário de atendimento: dias úteis, das 8h às 18h, no fuso America/Sao_Paulo.

## Stack

Ver stack.md.

## Principles

- Toda regra de negócio tem teste automatizado.
- Erros de validação respondem HTTP 400 com a mensagem de cada campo.

## Deploy target

docker-local

## GitHub owner

