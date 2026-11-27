// The agent's procedures on the client (contracts/agent.md "Procedures"): the
// server's limits. A wiki page becomes a procedure's instructions through
// htmlToMarkdown (lib/markdown.ts).

export const MAX_PROCEDURES = 50;
export const PROCEDURE_NAME_MAX = 80;
export const PROCEDURE_WHEN_MIN = 3;
export const PROCEDURE_WHEN_MAX = 300;
export const PROCEDURE_INSTRUCTIONS_MAX = 8000;

/** Why a procedure's fields can't be saved, per field; empty when they can. */
export function procedureProblems(p: { name: string; when: string; instructions: string }): { name?: true; when?: true; instructions?: true } {
  const name = p.name.trim().length;
  const when = p.when.trim().length;
  const ins = p.instructions.trim().length;
  return {
    ...(name < 1 || name > PROCEDURE_NAME_MAX ? { name: true as const } : {}),
    ...(when < PROCEDURE_WHEN_MIN || when > PROCEDURE_WHEN_MAX ? { when: true as const } : {}),
    ...(ins < 1 || ins > PROCEDURE_INSTRUCTIONS_MAX ? { instructions: true as const } : {}),
  };
}
