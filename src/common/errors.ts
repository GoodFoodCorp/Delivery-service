/**
 * Typed business errors. The HTTP exception filter and the WS gateway map
 * codes to transport-level responses; services/domain never deal with HTTP.
 */
export enum DomainErrorCode {
  Validation = 'VALIDATION',
  NotFound = 'NOT_FOUND',
  Forbidden = 'FORBIDDEN',
  Conflict = 'CONFLICT',
}

export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }

  static validation(message: string): DomainError {
    return new DomainError(DomainErrorCode.Validation, message);
  }

  static notFound(message: string): DomainError {
    return new DomainError(DomainErrorCode.NotFound, message);
  }

  static forbidden(message: string): DomainError {
    return new DomainError(DomainErrorCode.Forbidden, message);
  }

  static conflict(message: string): DomainError {
    return new DomainError(DomainErrorCode.Conflict, message);
  }
}
