import { buildDuplicateCheckMessages } from '../../../shared/prompts';
import { aiClient } from '../../../shared/ai';
import type { DuplicateCheckReport } from '../types';

export async function requestDuplicateCheck(documentContent: string) {
  const messages = buildDuplicateCheckMessages({ documentContent });
  return aiClient.requestJson<DuplicateCheckReport>({ messages, schemaName: 'DuplicateCheckReport', logTitle: '标书查重' });
}
