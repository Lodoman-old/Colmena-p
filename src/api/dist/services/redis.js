"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RedisService = void 0;
exports.setupRedis = setupRedis;
const ioredis_1 = __importDefault(require("ioredis"));
class RedisService {
    constructor() {
        this.redis = new ioredis_1.default({
            host: process.env.REDIS_HOST || 'redis',
            port: parseInt(process.env.REDIS_PORT || '6379'),
            password: process.env.REDIS_PASSWORD,
        });
    }
    async set(key, value, ttl) {
        const stringValue = JSON.stringify(value);
        if (ttl) {
            await this.redis.setex(key, ttl, stringValue);
        }
        else {
            await this.redis.set(key, stringValue);
        }
    }
    async get(key) {
        const value = await this.redis.get(key);
        return value ? JSON.parse(value) : null;
    }
    async del(key) {
        await this.redis.del(key);
    }
    async quit() {
        await this.redis.quit();
    }
}
exports.RedisService = RedisService;
async function setupRedis() {
    return new RedisService();
}
//# sourceMappingURL=redis.js.map