const FAILURE_PATTERNS: Array<[RegExp, string]> = [
  [/permission denied/i, 'authentication failed'],
  [/could not resolve hostname/i, 'host not found'],
  [/name or service not known/i, 'host not found'],
  [/connection refused/i, 'connection refused'],
  [/connection timed out/i, 'connection timed out'],
  [/network is unreachable/i, 'network unreachable'],
  [/no route to host/i, 'no route to host'],
  [/identity file .* not accessible/i, 'identity file not accessible'],
  [/(command not found|is not recognized as an internal or external command)/i, 'ssh executable not found'],
];

export function detectFailureHint(output: string) {
  for (const [pattern, reason] of FAILURE_PATTERNS) {
    if (pattern.test(output)) {
      return reason;
    }
  }

  return null;
}
