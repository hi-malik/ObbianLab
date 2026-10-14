import { Type } from 'class-transformer';
import { IsISO8601, IsIn, IsInt, IsString, IsUUID, Length, Max, Min, Matches, MaxLength, IsOptional } from 'class-validator';

export class CreatePaymentDto {
  @IsUUID() bookingId!: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) amountMinor!: number;
  @IsString() @Matches(/^[a-zA-Z]{3}$/) currency!: string;
}

export class SandboxWebhookDto {
  @IsString() @Length(1, 200) eventId!: string;
  @IsIn(['payment.authorized', 'payment.captured', 'payment.failed', 'payment.refunded'])
  type!: 'payment.authorized' | 'payment.captured' | 'payment.failed' | 'payment.refunded';
  @IsString() @Length(1, 200) gatewayPaymentId!: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) amountMinor!: number;
  @IsOptional() @IsString() @Length(1, 200) refundId?: string;
  @IsOptional() @IsString() @Matches(/^[a-zA-Z]{3}$/) currency?: string;
}

export class CreateSettlementDto {
  @IsUUID() professionalId!: string;
  @IsString() @Matches(/^[a-zA-Z]{3}$/) currency!: string;
  @IsISO8601() periodStart!: string;
  @IsISO8601() periodEnd!: string;
}

export class CreateRefundDto {
  @Type(() => Number) @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) amountMinor!: number;
}
