function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}
export const config = {
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://obbian:obbian@localhost:5432/obbian',
  brokers: (process.env.KAFKA_BROKERS ?? 'localhost:19092').split(','),
  eventTopic: process.env.EVENT_TOPIC ?? 'domain-events.v1',
  retryTopic: process.env.RETRY_TOPIC ?? 'domain-events.retry.v1',
  dlqTopic: process.env.DLQ_TOPIC ?? 'domain-events.dlq.v1',
  consumerName: process.env.CONSUMER_NAME ?? 'reporting-v1',
  maxAttempts: positiveInteger('MAX_PROCESSING_ATTEMPTS', 5),
  concurrency: positiveInteger('CONSUMER_CONCURRENCY', 8),
  healthPort: positiveInteger('HEALTH_PORT', 8090),
  kafkaAuthMode: process.env.KAFKA_AUTH_MODE ?? 'plaintext',
  awsRegion: process.env.AWS_REGION,
};
if (!['plaintext', 'iam'].includes(config.kafkaAuthMode)) throw new Error('unsupported KAFKA_AUTH_MODE');
if (config.kafkaAuthMode === 'iam' && !config.awsRegion) throw new Error('AWS_REGION required for MSK IAM authentication');
