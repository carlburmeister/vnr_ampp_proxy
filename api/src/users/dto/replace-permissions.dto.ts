import { ArrayMaxSize, IsArray, IsInt, IsUUID, Max, Min, ValidateIf } from 'class-validator';

export class ReplacePermissionsDto {
  // Skip only omission: null must fail validation rather than erase grants.
  @ValidateIf((_object, value) => value !== undefined)
  @IsArray()
  @ArrayMaxSize(500)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(2147483647, { each: true })
  gvuiLayoutIds?: number[];

  @IsArray()
  @ArrayMaxSize(500)
  @IsInt({ each: true })
  workloadIds!: number[];

  @IsArray()
  @ArrayMaxSize(500)
  @IsInt({ each: true })
  dashboardIds!: number[];

  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID('all', { each: true })
  deniedChildWorkloadIds!: string[];
}
