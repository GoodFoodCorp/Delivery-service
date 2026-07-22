import { ApiProperty } from '@nestjs/swagger';
import { IsMongoId, IsNotEmpty } from 'class-validator';

export class SubscribeDto {
  @ApiProperty({ description: 'Delivery id to watch' })
  @IsMongoId()
  @IsNotEmpty()
  deliveryId: string;
}
