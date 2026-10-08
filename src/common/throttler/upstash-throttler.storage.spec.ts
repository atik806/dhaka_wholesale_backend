import { Redis } from '@upstash/redis';
import { UpstashThrottlerStorage } from './upstash-throttler.storage';
import { clientIpTracker } from './client-ip.tracker';

function storageWith(evalImpl: jest.Mock) {
  return new UpstashThrottlerStorage({ eval: evalImpl } as unknown as Redis);
}

describe('UpstashThrottlerStorage', () => {
  it('maps the script result to a throttler record in seconds', async () => {
    const evalMock = jest.fn().mockResolvedValue([3, 41_200, 0, 0]);
    const record = await storageWith(evalMock).increment(
      'k',
      60_000,
      5,
      60_000,
      'default',
    );

    expect(record).toEqual({
      totalHits: 3,
      timeToExpire: 42,
      isBlocked: false,
      timeToBlockExpire: 0,
    });
    expect(evalMock).toHaveBeenCalledWith(
      expect.any(String),
      ['dw:throttle:default:k:hits', 'dw:throttle:default:k:block'],
      ['60000', '5', '60000'],
    );
  });

  it('reports a block', async () => {
    const evalMock = jest.fn().mockResolvedValue([6, 30_000, 1, 59_001]);
    const record = await storageWith(evalMock).increment(
      'k',
      60_000,
      5,
      60_000,
      'default',
    );
    expect(record.isBlocked).toBe(true);
    expect(record.timeToBlockExpire).toBe(60);
  });

  it('fails open to in-memory counting when Redis errors', async () => {
    const evalMock = jest.fn().mockRejectedValue(new Error('down'));
    const storage = storageWith(evalMock);
    jest.spyOn(storage['logger'], 'error').mockImplementation(() => {});

    const first = await storage.increment('k', 60_000, 1, 60_000, 'default');
    const second = await storage.increment('k', 60_000, 1, 60_000, 'default');

    expect(first.isBlocked).toBe(false);
    expect(second.isBlocked).toBe(true);
    storage['fallback'].onApplicationShutdown();
  });
});

describe('clientIpTracker', () => {
  const original = process.env.VERCEL;
  afterEach(() => {
    if (original === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = original;
  });

  const req = (headers: Record<string, string>) => ({
    ip: '10.0.0.1',
    headers,
  });

  it('ignores forwarding headers off Vercel (spoofable)', async () => {
    delete process.env.VERCEL;
    await expect(
      clientIpTracker(req({ 'x-real-ip': '1.2.3.4' })),
    ).resolves.toBe('10.0.0.1');
  });

  it('uses x-real-ip, then the first x-forwarded-for hop, on Vercel', async () => {
    process.env.VERCEL = '1';
    await expect(
      clientIpTracker(req({ 'x-real-ip': '1.2.3.4' })),
    ).resolves.toBe('1.2.3.4');
    await expect(
      clientIpTracker(req({ 'x-forwarded-for': '5.6.7.8, 10.0.0.2' })),
    ).resolves.toBe('5.6.7.8');
  });
});
