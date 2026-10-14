import { config } from './config';
import { createKafka } from './outbox';

async function main() {
  const admin = createKafka().admin();
  await admin.connect();
  try {
    const existing = new Set(await admin.listTopics());
    const definitions = [
      { topic: config.eventTopic, numPartitions: 12 },
      { topic: config.retryTopic, numPartitions: 12 },
      { topic: config.dlqTopic, numPartitions: 3 },
    ];
    const missing = definitions.filter((topic) => !existing.has(topic.topic));
    if (missing.length) await admin.createTopics({ waitForLeaders: true, topics: missing });
    const topics = await admin.fetchTopicMetadata({ topics: [config.eventTopic,config.retryTopic,config.dlqTopic] });
    if (topics.topics.some((topic) => !topic.partitions.length)) throw new Error('topic has no partitions');
    console.log(JSON.stringify({ status: 'ready', topics: topics.topics.map((topic) => ({name:topic.name,partitions:topic.partitions.length})) }));
  } finally { await admin.disconnect(); }
}
void main().catch((error) => { console.error(String(error)); process.exitCode = 1; });
