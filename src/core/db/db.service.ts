import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';

/** Exposes DB connection state for readiness checks. */
@Injectable()
export class DbService {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  /** mongoose readyState 1 === connected. */
  isConnected(): boolean {
    return this.connection.readyState === 1;
  }
}
