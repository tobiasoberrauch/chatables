/**
 * Retry with exponential backoff and jitter.
 * Used by all data adapters and external API calls.
 */

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: boolean;
  onRetry?: (error: Error, attempt: number, delayMs: number) => void;
}

const DEFAULT_OPTIONS: RetryOptions = {
  maxRetries: 5,
  baseDelayMs: 1000,
  maxDelayMs: 60000,
  jitter: true,
};

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: Partial<RetryOptions> = {},
): Promise<T> {
  const options = { ...DEFAULT_OPTIONS, ...opts };
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt === options.maxRetries) break;

      let delay = Math.min(
        options.baseDelayMs * Math.pow(2, attempt),
        options.maxDelayMs,
      );

      if (options.jitter) {
        delay = delay * (0.5 + Math.random() * 0.5);
      }

      options.onRetry?.(lastError, attempt + 1, delay);
      await sleep(delay);
    }
  }

  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Circuit breaker to prevent cascading failures.
 * Wraps an async function with failure tracking.
 */
export enum CircuitState {
  CLOSED = 'CLOSED',       // Normal operation
  OPEN = 'OPEN',           // Failing, reject immediately
  HALF_OPEN = 'HALF_OPEN', // Testing recovery
}

export interface CircuitBreakerOptions {
  failureThreshold: number;
  resetTimeoutMs: number;
  halfOpenMaxAttempts: number;
}

export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failureCount = 0;
  private lastFailureTime = 0;
  private halfOpenAttempts = 0;
  private readonly options: CircuitBreakerOptions;

  constructor(
    private readonly name: string,
    opts: Partial<CircuitBreakerOptions> = {},
  ) {
    this.options = {
      failureThreshold: 5,
      resetTimeoutMs: 30000,
      halfOpenMaxAttempts: 1,
      ...opts,
    };
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === CircuitState.OPEN) {
      if (Date.now() - this.lastFailureTime >= this.options.resetTimeoutMs) {
        this.state = CircuitState.HALF_OPEN;
        this.halfOpenAttempts = 0;
      } else {
        throw new CircuitOpenError(this.name);
      }
    }

    if (this.state === CircuitState.HALF_OPEN) {
      if (this.halfOpenAttempts >= this.options.halfOpenMaxAttempts) {
        this.state = CircuitState.OPEN;
        this.lastFailureTime = Date.now();
        throw new CircuitOpenError(this.name);
      }
      this.halfOpenAttempts++;
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    this.failureCount = 0;
    this.state = CircuitState.CLOSED;
  }

  private onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.failureCount >= this.options.failureThreshold) {
      this.state = CircuitState.OPEN;
    }
  }

  getState(): CircuitState {
    return this.state;
  }
}

export class CircuitOpenError extends Error {
  constructor(circuitName: string) {
    super(`Circuit breaker '${circuitName}' is OPEN — requests rejected`);
    this.name = 'CircuitOpenError';
  }
}
