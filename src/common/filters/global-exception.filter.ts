import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Response, Request } from 'express';
import { DomainError, DomainErrorCode } from '../errors';

const STATUS_BY_CODE: Record<DomainErrorCode, number> = {
  [DomainErrorCode.Validation]: HttpStatus.BAD_REQUEST,
  [DomainErrorCode.NotFound]: HttpStatus.NOT_FOUND,
  [DomainErrorCode.Forbidden]: HttpStatus.FORBIDDEN,
  [DomainErrorCode.Conflict]: HttpStatus.CONFLICT,
};

/** Maps typed business errors (and everything else) to JSON HTTP responses. */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    const requestId = res.getHeader('X-Request-ID');

    if (exception instanceof DomainError) {
      res.status(STATUS_BY_CODE[exception.code]).json({ error: exception.message, request_id: requestId });
      return;
    }

    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      const message =
        typeof body === 'string' ? body : ((body as Record<string, unknown>).message ?? exception.message);
      res.status(exception.getStatus()).json({ error: message, request_id: requestId });
      return;
    }

    this.logger.error(`Unhandled exception on ${req.method} ${req.url}`, (exception as Error)?.stack);
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ error: 'internal server error', request_id: requestId });
  }
}
