import Redis from 'ioredis';

export class RedisService {
  private redis: Redis;

  constructor() {
    this.redis = new Redis({
      host: process.env.REDIS_HOST || 'redis',
      port: parseInt(process.env.REDIS_PORT || '6379'),
      password: process.env.REDIS_PASSWORD,
    });
  }

  async set(key: string, value: any, ttl?: number): Promise<void> {
    const stringValue = JSON.stringify(value);
    if (ttl) {
      await this.redis.setex(key, ttl, stringValue);
    } else {
      await this.redis.set(key, stringValue);
    }
  }

  async get<T>(key: string): Promise<T | null> {
    const value = await this.redis.get(key);
    return value ? JSON.parse(value) : null;
  }

  async del(key: string): Promise<void> {
    await this.redis.del(key);
  }

  async quit(): Promise<void> {
    await this.redis.quit();
  }
}

export async function setupRedis(): Promise<RedisService> {
  return new RedisService();
}
