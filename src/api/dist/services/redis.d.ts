export declare class RedisService {
    private redis;
    constructor();
    set(key: string, value: any, ttl?: number): Promise<void>;
    get<T>(key: string): Promise<T | null>;
    del(key: string): Promise<void>;
    quit(): Promise<void>;
}
export declare function setupRedis(): Promise<RedisService>;
//# sourceMappingURL=redis.d.ts.map