export class HttpError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message: string, details?: unknown) => new HttpError(400, 'bad_request', message, details);
export const validation = (details: Record<string, string>) =>
  new HttpError(422, 'validation_error', 'One or more fields are invalid', details);
export const notFound = (what: string) => new HttpError(404, 'not_found', `${what} not found`);
export const conflict = (message: string, details?: unknown) => new HttpError(409, 'conflict', message, details);
export const forbidden = (message = 'You do not have permission for this action') =>
  new HttpError(403, 'forbidden', message);
export const unauthorized = () => new HttpError(401, 'unauthorized', 'Sign in required (X-User header)');
export const unavailable = (message: string) => new HttpError(503, 'service_unavailable', message);
