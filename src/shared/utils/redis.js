// src/shared/utils/redis.js
// Client Redis global (di-set oleh plugins/redis.js). Semua key otomatis
// berprefix "si:" lewat opsi keyPrefix ioredis.
let redisClient = null;

export const setRedisClient = (client) => {
  redisClient = client;
};

export const getRedisClient = () => redisClient;
