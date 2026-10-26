export class ApiError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(provider: string, path: string, status: number, body: string) {
    super(`${provider} ${path} failed with ${status}: ${body.slice(0, 500)}`);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}
