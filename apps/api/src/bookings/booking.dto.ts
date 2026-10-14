import { Type } from 'class-transformer';
import { IsIn, IsISO8601, IsLatitude, IsLongitude, IsString, IsUUID, MaxLength, MinLength, Max, Min, IsInt } from 'class-validator';

export class CreateBookingDto {
  @IsUUID() categoryId!: string;
  @Type(() => Number) @IsLatitude() latitude!: number;
  @Type(() => Number) @IsLongitude() longitude!: number;
  @IsString() @MinLength(1) @MaxLength(500) address!: string;
  @IsISO8601() scheduledFor!: string;
  @Type(() => Number) @IsInt() @Min(5) @Max(1440) durationMinutes = 60;
  @Type(() => Number) @IsInt() @Min(120) @Max(14400) maxEtaSeconds = 1800;
}

export class TrackLocationDto {
  @Type(() => Number) @IsLatitude() latitude!: number;
  @Type(() => Number) @IsLongitude() longitude!: number;
  @IsISO8601() recordedAt!: string;
}

export class AvailabilityDto {
  @IsUUID() categoryId!: string;
  @Type(() => Number) @IsLatitude() latitude!: number;
  @Type(() => Number) @IsLongitude() longitude!: number;
  @IsISO8601() scheduledFor!: string;
  @Type(() => Number) @IsInt() @Min(5) @Max(1440) durationMinutes = 60;
  @Type(() => Number) @IsInt() @Min(120) @Max(14400) maxEtaSeconds = 1800;
}

export class ProfessionalPresenceDto {
  @Type(() => Number) @IsLatitude() latitude!: number;
  @Type(() => Number) @IsLongitude() longitude!: number;
  @IsIn(['available', 'busy', 'offline']) status!: 'available' | 'busy' | 'offline';
}
