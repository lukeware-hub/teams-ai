/** A question about what happened, why, or what to do: its answer carries the three labels. Counting and timing questions do not. */
const DIAGNOSIS = /impedimento|causa|falh|investig|fazer|bloque|parou|por que|porque|erro|travad|atrasad/i;
const COUNTING = /^\s*quant/i;
const LABEL = 'O que está acontecendo';
/** A sentence that says a fact is not in the records. */
const NOT_RECORDED = /\bnão (trazem?|tem|têm|há|existe|consta|está|estão|foi|é possível|consigo|encontrei)(?=[\s.,;:]|$)/i;
/** Names of the records a question's answer can point to. */
const RECORD_NAME = /histórico|arquivo de falhas|documentos do projeto|o guia|registro completo/i;
const POINTER = 'Onde procurar: o histórico de cada execução e o arquivo de falhas da spec (falhas/<spec>.md).';

export function needsLabels(question: string, answer: string): boolean {
  return DIAGNOSIS.test(question) && !COUNTING.test(question) && !answer.includes(LABEL);
}

/** When an answer says a fact is missing and names no record, it says where the records are kept; it never guesses which one holds the fact. */
export function withRecordPointer(answer: string): string {
  return NOT_RECORDED.test(answer) && !RECORD_NAME.test(answer) ? `${answer}\n\n${POINTER}` : answer;
}
