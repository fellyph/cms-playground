// Structured CLI/core error types, classified exit codes, and RFC 6901 JSON Pointer helpers.

export const EXIT_CODES = Object.freeze({
  OK: 0,
  UNKNOWN: 1,
  VALIDATION: 2,
  NOT_FOUND: 20,
  CONFLICT: 30,
  NETWORK: 40,
  TIMEOUT: 50,
  CANCELLED: 130,
});

/**
 * Formats path segments into an RFC 6901 JSON Pointer (e.g. ['steps', 2, 'plugin'] -> '/steps/2/plugin').
 */
export function formatJsonPointer(...segments) {
  if (segments.length === 0) {
    return '';
  }

  return (
    '/' +
    segments
      .map((seg) => String(seg).replace(/~/g, '~0').replace(/\//g, '~1'))
      .join('/')
  );
}

/**
 * Structured error carrying a stable machine-readable code, classified exit code,
 * retryability flag, runnable recovery command, suggestions, and optional RFC 6901 pointer.
 */
export class PlaygroundError extends Error {
  constructor(
    message,
    {
      code = 'unknown_error',
      exitCode = EXIT_CODES.UNKNOWN,
      retryable = false,
      recovery = null,
      suggestions = [],
      pointer = undefined,
      cause = undefined,
    } = {}
  ) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'PlaygroundError';
    this.code = code;
    this.exitCode = exitCode;
    this.retryable = Boolean(retryable);
    this.recovery = recovery ?? null;
    this.suggestions = Array.isArray(suggestions) ? [...suggestions] : [];
    if (pointer !== undefined) {
      this.pointer = pointer;
    }
  }
}

/**
 * Converts any thrown error into a classified PlaygroundError.
 */
export function classifyError(error, { cms = null } = {}) {
  if (error instanceof PlaygroundError) {
    if (error.code === 'port_in_use' && !error.recovery && cms) {
      return new PlaygroundError(error.message, {
        code: error.code,
        exitCode: error.exitCode,
        retryable: error.retryable,
        recovery: `cms-playground start --${cms} --port=0`,
        suggestions: error.suggestions,
        pointer: error.pointer,
        cause: error.cause,
      });
    }

    return error;
  }

  const message = error?.message ?? String(error);
  const sysCode = error?.code ?? error?.cause?.code;
  const name = error?.name;

  if (sysCode === 'EADDRINUSE') {
    const cmsFlag = cms ? `--${cms}` : '--joomla';
    return new PlaygroundError(message, {
      code: 'port_in_use',
      exitCode: EXIT_CODES.CONFLICT,
      retryable: false,
      recovery: `cms-playground start ${cmsFlag} --port=0`,
      suggestions: ['Pass --port=0 to bind an ephemeral free port, or choose another --port.'],
      cause: error,
    });
  }

  if (name === 'TimeoutError' || name === 'AbortError' || sysCode === 'ETIMEDOUT') {
    return new PlaygroundError(message, {
      code: 'timeout',
      exitCode: EXIT_CODES.TIMEOUT,
      retryable: true,
      suggestions: ['Retry the command or check your network connection.'],
      cause: error,
    });
  }

  if (
    sysCode === 'ENOTFOUND' ||
    sysCode === 'ECONNREFUSED' ||
    sysCode === 'ECONNRESET' ||
    sysCode === 'EAI_AGAIN' ||
    sysCode === 'UND_ERR_CONNECT_TIMEOUT' ||
    sysCode === 'UND_ERR_SOCKET'
  ) {
    return new PlaygroundError(message, {
      code: 'network_error',
      exitCode: EXIT_CODES.NETWORK,
      retryable: true,
      suggestions: ['Check your network connection and retry the command.'],
      cause: error,
    });
  }

  if (sysCode === 'ENOENT') {
    return new PlaygroundError(message, {
      code: 'file_not_found',
      exitCode: EXIT_CODES.NOT_FOUND,
      retryable: false,
      cause: error,
    });
  }

  return new PlaygroundError(message, {
    code: 'unknown_error',
    exitCode: EXIT_CODES.UNKNOWN,
    retryable: false,
    cause: error,
  });
}

/**
 * Serializes any error into the uniform `{ error: { ... } }` JSON payload for stderr.
 */
export function toErrorPayload(error, context = {}) {
  const classified = classifyError(error, context);
  const body = {
    code: classified.code,
    message: classified.message,
    retryable: classified.retryable,
    recovery: classified.recovery,
    suggestions: classified.suggestions,
  };

  if (classified.pointer !== undefined) {
    body.pointer = classified.pointer;
  }

  return { error: body };
}
