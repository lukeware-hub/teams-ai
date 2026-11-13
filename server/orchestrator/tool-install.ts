/** The only commands a Dev may ask the platform to run with network: one tool installed into .tools of the worktree. */
const ALLOWED: ReadonlyArray<RegExp> = [
  /^GOBIN=\$PWD\/\.tools\/bin go install [\w.\/-]+@[\w.-]+$/,
  /^cargo install --locked --root \.tools [\w-]+(?: --version [\w.-]+)?$/,
  /^pip install --target \.tools\/py [\w.-]+(?:==[\w.-]+)?$/,
  /^npm install --no-save --prefix \.tools [\w@.\/-]+$/,
];

/** The reason a tool-install command is refused, or null when the platform may run it. */
export function toolInstallError(command: string): string | null {
  if (ALLOWED.some((re) => re.test(command.trim()))) return null;
  return 'toolInstall must be one install into .tools: `GOBIN=$PWD/.tools/bin go install <module>@<version>`, `cargo install --locked --root .tools <crate> --version <version>`, `pip install --target .tools/py <package>==<version>` or `npm install --no-save --prefix .tools <package>@<version>`';
}
