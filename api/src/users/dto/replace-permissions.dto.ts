import { ArrayMaxSize, IsArray, IsInt, IsUUID } from 'class-validator';

export class ReplacePermissionsDto {
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
