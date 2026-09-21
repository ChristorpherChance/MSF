/** 环境配置（M0；密钥管理见 HLD §6，模型/Git 令牌后续加密落库） */
export const config = {
  port: Number(process.env.MSF_PORT ?? 8080),
  databaseUrl:
    process.env.MSF_DATABASE_URL ?? 'postgres://msf:msf@localhost:5432/msf',
  redisUrl: process.env.MSF_REDIS_URL ?? 'redis://localhost:6379',
  minio: {
    endPoint: process.env.MSF_MINIO_ENDPOINT ?? 'localhost',
    port: Number(process.env.MSF_MINIO_PORT ?? 9000),
    accessKey: process.env.MSF_MINIO_ACCESS_KEY ?? 'msf',
    secretKey: process.env.MSF_MINIO_SECRET_KEY ?? 'msfsecret',
    bucket: process.env.MSF_MINIO_BUCKET ?? 'msf-artifacts',
  },
} as const;
