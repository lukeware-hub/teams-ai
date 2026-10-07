# Biblioteca Escolar

## Vision

Um serviço de API para a biblioteca de uma escola cadastrar livros, emprestar e receber devoluções, e tirar relatórios simples do acervo.

## Personas

- Bibliotecária: cadastra livros, registra empréstimos e devoluções e consulta relatórios.
- Aluno: leva o livro emprestado; não acessa o sistema.

## Constraints

- Uma única escola, até 10 mil livros e 2 mil alunos.
- Dados do aluno: só matrícula e nome (LGPD).

## Stack

Ver stack.md.

## Principles

- Toda regra de negócio tem teste automatizado.
- Erros de validação respondem HTTP 400 com a mensagem de cada campo.

## Deploy target

docker-local

## GitHub owner

