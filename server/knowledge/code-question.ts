import path from 'node:path';
import type { PlanTask } from '../contracts/plan.js';

/** The most file names added to the question: past a few the question is a list, not a question. */
const MAX_NAMES = 6;
const GLOB = /[*?[]/;

/**
 * The question put to the code graph for a task: what the task is, then the names of the files it will change. The graph finds code by
 * its names, so a question made only of the task's words reached other tasks' plans and documents instead of the files at hand.
 * A path that is a pattern names no file and is left out.
 */
export function codeQuestionOf(task: Pick<PlanTask, 'title' | 'description' | 'affectedPaths'>): string {
  const names = [...new Set(task.affectedPaths.filter((p) => !GLOB.test(p)).map((p) => path.posix.basename(p)))].slice(0, MAX_NAMES);
  return [task.title, task.description, ...names].join(' ');
}
