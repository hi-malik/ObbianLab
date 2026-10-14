import { Controller, Get } from '@nestjs/common';
import { Database } from '../database';

@Controller('health')
export class HealthController {
  constructor(private readonly database: Database) {}

  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready() {
    await this.database.query('SELECT 1');
    return { status: 'ready' };
  }
}
