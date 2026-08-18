// Erros da sandbox com código legível por máquina, para o cliente (e o modelo)
// saberem reagir em vez de só ver uma mensagem solta.
export class SandboxError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'SandboxError';
    this.code = code;
    this.status = status || SANDBOX_ERROR_STATUS[code] || 400;
  }
}

const SANDBOX_ERROR_STATUS = {
  sandbox_disabled: 404,
  sandbox_unavailable: 503,
  sandbox_image_missing: 503,
  forbidden_anonymous: 403,
  rate_limited: 429,
  too_many_concurrent: 429,
  session_not_found: 404,
  invalid_path: 400,
  invalid_request: 400,
  quota_exceeded: 400,
  payload_too_large: 413,
  network_not_allowed: 400,
  job_not_found: 404
};

export function sandboxError(code, message) {
  return new SandboxError(code, message);
}

export function toHttpError(err) {
  if (err instanceof SandboxError) {
    return { status: err.status, body: { error: { code: err.code, message: err.message } } };
  }
  return {
    status: 500,
    body: { error: { code: 'internal_error', message: err && err.message ? err.message : 'Erro interno na sandbox.' } }
  };
}
