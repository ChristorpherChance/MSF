/**
 * Pi SDK 加载器：@earendil-works/pi-* 为纯 ESM，server 产物为 CJS。
 * 经动态 import 加载（Node ≥22.12 起 CJS 可加载 ESM；vitest 下原生 import 可用——
 * 不可用 Function 构造式动态导入，vitest vm 不支持，M2 踩坑备记）。
 * 锁 0.86.0（任务分解 M6 注①）。
 */
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Model,
  ThinkingLevel,
  TranscriptContext,
  UserMessage,
} from '@earendil-works/pi-ai';

export type PiAi = typeof import('@earendil-works/pi-ai');
export type {
  AssistantMessage,
  AssistantMessageEvent,
  Model,
  ThinkingLevel,
  TranscriptContext,
  UserMessage,
};

export const loadPiAi = (): Promise<PiAi> => import('@earendil-works/pi-ai');

type AnthropicApi = typeof import('@earendil-works/pi-ai/api/anthropic-messages');
type OpenaiCompletionsApi = typeof import('@earendil-works/pi-ai/api/openai-completions');

export const loadAnthropicApi = (): Promise<AnthropicApi> =>
  import('@earendil-works/pi-ai/api/anthropic-messages');
export const loadOpenaiCompletionsApi = (): Promise<OpenaiCompletionsApi> =>
  import('@earendil-works/pi-ai/api/openai-completions');
