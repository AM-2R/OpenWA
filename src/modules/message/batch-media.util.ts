import { MessageBatch } from './entities/message-batch.entity';

/**
 * Drop base64 payloads from a finished batch's stored message list. A completed/cancelled batch is
 * terminal (never resumed), so the (often multi-MB) base64 in `message_batches.messages` is dead
 * weight; the descriptive fields (mimetype/filename/caption/url) are kept.
 */
export function stripBatchMediaPayloads(messages: MessageBatch['messages']): void {
  for (const m of messages ?? []) {
    for (const key of ['image', 'video', 'audio', 'document']) {
      const media = m.content[key] as { base64?: unknown } | undefined;
      if (media && typeof media === 'object' && 'base64' in media) {
        delete media.base64;
      }
    }
  }
}
