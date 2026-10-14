import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export interface RequestContextValue {
  tenantId: string;
  actorId: string;
  roles: string[];
  traceId: string;
}

export const RequestContext = createParamDecorator(
  (_data: unknown, context: ExecutionContext): RequestContextValue => context.switchToHttp().getRequest().context,
);
