export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, status = 400, details: Record<string, unknown> = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export class NotFoundError extends AppError {
  constructor(entity: string, id: string) {
    super('not_found', `${entity} not found: ${id}`, 404, { entity, id });
  }
}

export class ValidationError extends AppError {
  readonly path: string;
  constructor(path: string, message: string) {
    super('validation_error', `${path || 'input'}: ${message}`, 422, { path });
    this.path = path;
  }
}

/** A business rule refused the action (e.g. suppressed contact, rate limit, invalid funnel transition). */
export class PolicyError extends AppError {
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(code, message, 409, details);
  }
}
