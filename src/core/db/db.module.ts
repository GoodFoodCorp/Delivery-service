import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { DbService } from './db.service';

/** Owns the MongoDB connection for the whole app (global: DbService and the
 *  Mongoose connection are injectable everywhere). */
@Global()
@Module({
  imports: [
    MongooseModule.forRootAsync({
      useFactory: () => ({
        uri: process.env.MONGODB_URI ?? 'mongodb://localhost:27017/delivery_db',
      }),
    }),
  ],
  providers: [DbService],
  exports: [DbService],
})
export class DbModule {}
