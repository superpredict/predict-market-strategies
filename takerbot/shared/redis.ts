import { Redis } from 'ioredis';
import { REDIS_URL } from '../config/constants.js';

let _client: Redis | null = null;
let _subscriber: Redis | null = null;

/**
 * Returns (and lazily creates) the shared Redis client used for GET/SET/PUBLISH.
 * A single client is reused across the process lifetime.
 */
export function getRedisClient(): Redis {
  if (!_client) {
    _client = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 3,
      enableOfflineQueue: true,
      lazyConnect: false,
    });

    _client.on('error', (err: Error) => {
      console.error('[redis] client error:', err.message);
    });

    _client.on('connect', () => {
      console.log('[redis] connected to', REDIS_URL);
    });
  }

  return _client;
}

/**
 * Returns a dedicated Redis connection for SUBSCRIBE / PSUBSCRIBE.
 * Redis requires a separate connection for pub/sub mode.
 */
export function getSubscriberClient(): Redis {
  if (!_subscriber) {
    _subscriber = new Redis(REDIS_URL, {
      maxRetriesPerRequest: null, // unlimited retries for subscriber
      enableOfflineQueue: true,
      lazyConnect: false,
    });

    _subscriber.on('error', (err: Error) => {
      console.error('[redis:sub] subscriber error:', err.message);
    });
  }

  return _subscriber;
}

/** Gracefully close both Redis connections. */
export async function closeRedis(): Promise<void> {
  if (_client) {
    await _client.quit();
    _client = null;
  }
  if (_subscriber) {
    await _subscriber.quit();
    _subscriber = null;
  }
}
