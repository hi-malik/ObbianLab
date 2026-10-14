import { Inject, Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient, QueryResultRow } from 'pg';

export const PG_POOL = Symbol('PG_POOL');

@Injectable()
export class Database implements OnModuleDestroy {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  query<T extends QueryResultRow>(text: string, values: unknown[] = []) {
    return this.pool.query<T>(text, values);
  }

  async transaction<T>(work: (client: PoolClient) => Promise<T>, isolation = 'READ COMMITTED'): Promise<T> {
    // Retry only fully rolled-back transactions. All external delivery uses the outbox.
    for (let attempt = 0; ; attempt++) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SET TRANSACTION ISOLATION LEVEL ${isolation}`);
        const result = await work(client);
        await client.query('COMMIT');
        return result;
      } catch (error: any) {
        await client.query('ROLLBACK');
        if (!['40001', '40P01'].includes(error?.code) || attempt >= 4) throw error;
      } finally {
        client.release();
      }
      await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attempt + Math.random() * 15));
    }
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}

@Module({
  providers: [
    {
      provide: PG_POOL,
      useFactory: () => new Pool({
        connectionString: process.env.DATABASE_URL ?? 'postgres://obbian:obbian@localhost:5432/obbian',
        max: Number(process.env.DB_POOL_SIZE ?? 20),
        statement_timeout: 10_000,
        application_name: 'obbian-api',
      }),
    },
    Database,
  ],
  exports: [Database, PG_POOL],
})
export class DatabaseModule {}
