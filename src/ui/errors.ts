/**
 * Error classification for the UI. Renders calm, actionable messages and NEVER
 * leaks secret values. Raw errors should be logged to stderr/file, not here.
 */

/** Map an error to a short, safe, user-facing string. */
export function classifyError(err: unknown): string {
  if (err instanceof Error) {
    const name = err.name;
    const msg = err.message;
    switch (name) {
      case 'KeychainError':
        return 'incorrect password';
      case 'AwsAuthError':
        return `auth failed: ${msg}`;
      case 'OfflineError':
        return 'offline: AWS unreachable';
      case 'ConflictError':
        return 'sync conflict — remote changed';
      case 'DuplicateKeyError':
        return msg; // already safe: only mentions the key, never the value
      case 'NotFoundError':
        return msg;
      case 'ThrottlingException':
        return 'throttled by AWS — retrying…';
      default:
        // Generic fallback. The message here may include an AWS error name but
        // never a secret value (those never flow into error messages by design).
        return msg || 'an error occurred';
    }
  }
  return 'an unexpected error occurred';
}
