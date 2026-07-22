/** Typed accessor over environment configuration (12-factor). */
export interface AppConfig {
  port: number;
  logLevel: string;
  mongoUri: string;
  jwtSecret: string;
  orderServiceUrl: string;
}

export function loadConfig(): AppConfig {
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    throw new Error('JWT_SECRET is required');
  }
  return {
    port: Number(process.env.PORT ?? 8084),
    logLevel: process.env.LOG_LEVEL ?? 'info',
    mongoUri: process.env.MONGODB_URI ?? 'mongodb://localhost:27017/delivery_db',
    jwtSecret,
    orderServiceUrl: process.env.ORDER_SERVICE_URL ?? 'http://order-service:8082',
  };
}
