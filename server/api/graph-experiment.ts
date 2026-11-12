// Shared with the web page, so this file imports no Node module.

/** Steps each arm needs before the comparison of the graph experiment says anything. */
export const MIN_ARM_STEPS = 10;
/** Different specs each arm needs: an arm is chosen per spec, so one or two specs mix the graph's effect with the size of the spec. */
export const MIN_ARM_SPECS = 5;

/** Whether both arms have steps and specs enough for their difference to mean something. */
export const armsConclusive = (steps: { graph: number; control: number }, specs: { graph: number; control: number }): boolean =>
  Math.min(steps.graph, steps.control) >= MIN_ARM_STEPS && Math.min(specs.graph, specs.control) >= MIN_ARM_SPECS;
