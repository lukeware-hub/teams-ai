/** Empty dotfiles the sandbox leaves in a worktree as mount points for protected files: not the Dev's work. */
export const SANDBOX_PLACEHOLDERS: ReadonlySet<string> = new Set(['.bash_profile', '.bashrc', '.gitconfig', '.gitmodules', '.idea', '.mcp.json', '.profile', '.ripgreprc', '.vscode', '.zprofile', '.zshrc']);

/** The changed files without the sandbox's placeholders, which a step that was cut short can leave behind. */
export const devChangedFiles = (names: readonly string[]): string[] => names.filter((f) => !SANDBOX_PLACEHOLDERS.has(f));
