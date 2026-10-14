import { describe, expect, it, vi } from 'vitest';
import { Database } from '../src/database';
describe('transaction failure recovery', () => {
  it('rolls back and retries serialization conflicts before committing once', async () => {
    const client = { query: vi.fn().mockResolvedValue({}), release: vi.fn() };
    const pool = { connect: vi.fn().mockResolvedValue(client) };
    const work = vi.fn().mockRejectedValueOnce({ code: '40001' }).mockResolvedValueOnce('success');
    expect(await new Database(pool as any).transaction(work, 'SERIALIZABLE')).toBe('success');
    expect(client.query.mock.calls.filter(([query]) => query === 'ROLLBACK')).toHaveLength(1);
    expect(client.query.mock.calls.filter(([query]) => query === 'COMMIT')).toHaveLength(1);
    expect(client.release).toHaveBeenCalledTimes(2);
  });
  it('never retries a business failure', async () => {
    const client = { query: vi.fn().mockResolvedValue({}), release: vi.fn() };
    const work = vi.fn().mockRejectedValue(new Error('invalid ledger'));
    await expect(new Database({ connect: async () => client } as any).transaction(work)).rejects.toThrow('invalid ledger');
    expect(work).toHaveBeenCalledTimes(1);
  });
});
