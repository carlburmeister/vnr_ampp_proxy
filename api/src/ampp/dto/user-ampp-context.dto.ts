import { Type } from 'class-transformer';
import { IsArray, IsOptional, IsString, ValidateNested } from 'class-validator';

export class AssignedAmppWorkloadDto {
  @IsOptional()
  @IsString()
  id?: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  applicationName?: string;
}

export class UserAmppContextDto {
  @IsString()
  platformUserId: string;

  @IsOptional()
  @IsString()
  displayName?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AssignedAmppWorkloadDto)
  assignedWorkloads: AssignedAmppWorkloadDto[];

  @IsOptional()
  @IsString()
  sessionId?: string;

  @IsOptional()
  @IsString()
  tenantId?: string;
}
