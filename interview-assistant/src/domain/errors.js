/** Domain errors. They carry a stable `code`; only the HTTP layer maps codes to status numbers. */
export class DomainError extends Error {
  constructor(message, code = 'INTERNAL') {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

export class ValidationError extends DomainError {
  constructor(message) { super(message, 'VALIDATION'); }
}
export class NotFoundError extends DomainError {
  constructor(message) { super(message, 'NOT_FOUND'); }
}
export class PayloadTooLargeError extends DomainError {
  constructor(message) { super(message, 'PAYLOAD_TOO_LARGE'); }
}
export class UnsupportedFormatError extends DomainError {
  constructor(message) { super(message, 'UNSUPPORTED_FORMAT'); }
}
export class NotConfiguredError extends DomainError {
  constructor(message) { super(message, 'NOT_CONFIGURED'); }
}
export class UpstreamError extends DomainError {
  constructor(message) { super(message, 'UPSTREAM'); }
}
export class ForbiddenError extends DomainError {
  constructor(message) { super(message, 'FORBIDDEN'); }
}
