export type Severity = 'error' | 'warning' | 'info';

export type RuleId =
  | 'matches-nothing'
  | 'matches-only-ignored'
  | 'vendored-leading-glob'
  | 'static-cache-key'
  | 'lockfile-manager-mismatch'
  | 'invalid-pattern';

export interface Finding {
  rule: RuleId;
  severity: Severity;
  file: string;
  line: number;
  message: string;
}

export interface LintOptions {
  /** Repository root that patterns are resolved against (mirrors GITHUB_WORKSPACE). */
  workspace: string;
}
