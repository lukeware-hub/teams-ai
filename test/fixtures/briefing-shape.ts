/** A briefing that follows the briefing template, with real content in every section. */
export const SHAPED_BRIEF = '## Type\n\nfeature\n\n## Objectives\n\n- Vender online.\n\n## Features\n\n- Carrinho de compras.\n\n## Acceptance criteria\n\n- AC-001 (smoke): Given um visitante, when ele adiciona um produto, then o carrinho mostra o produto.\n\n## Out of scope\n\n- (none)\n\n## External dependencies\n\n- (none)\n\n## Bug details\n\n- (not applicable)\n\n## Tasks\n\n- (none)\n';

/** The same briefing as a stage starts it: a placeholder left and a heading the template lacks. */
export const LOOSE_BRIEF = SHAPED_BRIEF
  .replace('- (none)\n\n## External', '- <item>\n\n## External')
  .replace('## Tasks', '## Regras de negócio\n\n- Pedido só com pagamento.\n\n## Tasks');
