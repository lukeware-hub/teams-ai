/** A state as a chip: the label in words, the tone from the state's table. */
export function StatePill({ label, tone }: { label: string; tone: string }) {
  return <span className={tone ? `status-pill tone-${tone}` : 'status-pill'}>{label}</span>;
}
