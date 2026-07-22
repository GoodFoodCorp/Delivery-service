import { ApiProperty } from '@nestjs/swagger';
import { IsLatitude, IsLongitude, IsMongoId, IsNotEmpty } from 'class-validator';

export class UpdatePositionDto {
  @ApiProperty({ description: 'Delivery id (Mongo ObjectId)' })
  @IsMongoId()
  @IsNotEmpty()
  deliveryId: string;

  @ApiProperty({ example: 48.8566 })
  @IsLatitude()
  lat: number;

  @ApiProperty({ example: 2.3522 })
  @IsLongitude()
  lng: number;
}
