const { Transform } = require('stream');
const Logger = require('./Logger');

// ---------------------------------------------------------------------------
// OpenAI <-> Anthropic translation.
//
// Pure translation only: no HTTP, no auth, no config reads. The proxy still
// speaks Anthropic natively end to end — these helpers just reshape the edges
// so clients that can only talk to /v1/chat/completions (game mods, front-ends
// with a hardcoded OpenAI path) reach the same /v1/messages pipeline, preset
// and all, and get an answer back in the schema they asked in.
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = 'claude-sonnet-5';
const DEFAULT_MAX_TOKENS = 4096;

// Anthropic rejects a conversation that doesn't open on a user turn; clients
// that start with the character's greeting would otherwise 400.
const PLACEHOLDER_USER_TEXT = '(Start of conversation.)';

// ...and newer models reject one that ends on an assistant turn, since that
// reads as a prefill. See normalizeMessages.
const PLACEHOLDER_CONTINUE_TEXT = '(Continue.)';

// Only for clients that hardcode an OpenAI model name. Anything already
// starting with "claude" passes through untouched; anything else unknown falls
// back to the configured default model.
const MODEL_ALIASES = {
  'gpt-3.5-turbo': 'claude-haiku-4-5-20251001',
  'gpt-4o-mini': 'claude-haiku-4-5-20251001',
  'gpt-4.1-mini': 'claude-haiku-4-5-20251001',
  'gpt-4o': 'claude-sonnet-5',
  'gpt-4.1': 'claude-sonnet-5',
  'gpt-4-turbo': 'claude-sonnet-5',
  'gpt-4': 'claude-opus-5',
  'gpt-5': 'claude-opus-5',
  'o1': 'claude-opus-5',
  'o3': 'claude-opus-5',
};

const KNOWN_MODELS = [
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-fable-5',
  'claude-haiku-4-5-20251001',
];

const FINISH_REASONS = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  pause_turn: 'stop',
  max_tokens: 'length',
  model_context_window_exceeded: 'length',
  tool_use: 'tool_calls',
  refusal: 'content_filter',
};

// OpenAI's reasoning_effort has no Anthropic equivalent; map it onto a thinking
// budget so o-series-shaped clients still get extended thinking.
const REASONING_BUDGETS = { minimal: 1024, low: 2048, medium: 8192, high: 16384 };

function safeJsonParse(str, fallback = null) {
  try {
    return JSON.parse(str);
  } catch (e) {
    return fallback;
  }
}

function isClaudeModel(name) {
  return typeof name === 'string' && /^claude/i.test(name.trim());
}

function resolveModel(requested, defaultModel = DEFAULT_MODEL) {
  const name = typeof requested === 'string' ? requested.trim() : '';
  if (!name) return defaultModel;
  if (isClaudeModel(name)) return name;

  const alias = MODEL_ALIASES[name.toLowerCase()];
  if (alias) {
    Logger.debug(`OpenAI compat: mapped model "${name}" to "${alias}"`);
    return alias;
  }

  Logger.debug(`OpenAI compat: unknown model "${name}", using default "${defaultModel}"`);
  return defaultModel;
}

function imageBlock(url) {
  if (typeof url !== 'string' || !url) return null;

  const dataUrl = /^data:([^;,]+);base64,([\s\S]*)$/.exec(url);
  if (dataUrl) {
    return { type: 'image', source: { type: 'base64', media_type: dataUrl[1], data: dataUrl[2] } };
  }
  if (/^https?:\/\//i.test(url)) {
    return { type: 'image', source: { type: 'url', url } };
  }
  return null;
}

// OpenAI content is a bare string or an array of parts; Anthropic always wants
// an array of typed blocks.
function convertContent(content) {
  if (content == null) return [];
  if (typeof content === 'string') {
    return content ? [{ type: 'text', text: content }] : [];
  }
  if (!Array.isArray(content)) return [];

  const blocks = [];
  content.forEach((part) => {
    if (!part) return;
    if (typeof part === 'string') {
      if (part) blocks.push({ type: 'text', text: part });
      return;
    }

    switch (part.type) {
      case 'text':
      case 'input_text':
      case 'output_text':
        if (part.text) blocks.push({ type: 'text', text: part.text });
        break;
      case 'image_url': {
        const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
        const block = imageBlock(url);
        if (block) blocks.push(block);
        break;
      }
      case 'input_image': {
        const block = imageBlock(part.image_url || part.image || part.url);
        if (block) blocks.push(block);
        break;
      }
      default:
        // Unknown part kinds (input_audio, file, …) have no Anthropic analogue.
        if (typeof part.text === 'string' && part.text) {
          blocks.push({ type: 'text', text: part.text });
        } else {
          Logger.debug(`OpenAI compat: dropping unsupported content part "${part.type}"`);
        }
    }
  });
  return blocks;
}

// Anthropic tool_result content takes a string or an array of blocks.
function convertToolResultContent(content) {
  if (typeof content === 'string') return content;
  const blocks = convertContent(content);
  if (!blocks.length) return '';
  if (blocks.every((b) => b.type === 'text')) return blocks.map((b) => b.text).join('');
  return blocks;
}

function convertToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls
    .filter((call) => call && (call.function || call.name))
    .map((call, i) => {
      const fn = call.function || call;
      return {
        type: 'tool_use',
        id: call.id || `call_${i}`,
        name: fn.name || `tool_${i}`,
        input: typeof fn.arguments === 'string'
          ? (safeJsonParse(fn.arguments, {}) || {})
          : (fn.arguments || {}),
      };
    });
}

function isBlankText(block) {
  return block.type === 'text' && !block.text.trim();
}

// Anthropic is stricter than OpenAI about message shape: roles must alternate,
// the first turn must be a user turn, and blocks can't be empty.
//
// The trailing turn is the subtle one. Anthropic reads a final assistant turn as
// a prefill to continue; OpenAI reads it as plain history and answers with a new
// assistant turn. Newer models reject prefill outright ("This model does not
// support assistant message prefill. The conversation must end with a user
// message."), and clients that build an assistant-only history — game mods that
// keep all their state in system messages — hit that on every single request.
// So OpenAI semantics win by default: close the conversation with a user turn.
// allowPrefill keeps the Anthropic reading for anyone who wants it, in which
// case the trailing whitespace has to go (Anthropic rejects it on a prefill).
function normalizeMessages(messages, allowPrefill = false) {
  const cleaned = [];
  messages.forEach((msg) => {
    const content = msg.content.filter((block) => !isBlankText(block));
    if (!content.length) return;

    const prev = cleaned[cleaned.length - 1];
    if (prev && prev.role === msg.role) {
      prev.content.push(...content);
      return;
    }
    cleaned.push({ role: msg.role, content });
  });

  if (!cleaned.length || cleaned[0].role !== 'user') {
    cleaned.unshift({ role: 'user', content: [{ type: 'text', text: PLACEHOLDER_USER_TEXT }] });
  }

  const last = cleaned[cleaned.length - 1];
  if (last.role === 'assistant') {
    if (allowPrefill) {
      const tail = last.content[last.content.length - 1];
      if (tail && tail.type === 'text') {
        tail.text = tail.text.replace(/\s+$/, '');
        if (!tail.text) last.content.pop();
        if (!last.content.length) cleaned.pop();
      }
    } else {
      cleaned.push({ role: 'user', content: [{ type: 'text', text: PLACEHOLDER_CONTINUE_TEXT }] });
    }
  }

  return cleaned;
}

function convertMessages(messages, allowPrefill = false) {
  const system = [];
  const converted = [];

  (Array.isArray(messages) ? messages : []).forEach((msg) => {
    if (!msg || typeof msg !== 'object') return;

    switch (msg.role) {
      case 'system':
      case 'developer':
        // Anthropic keeps system prompts out of the message list entirely.
        convertContent(msg.content)
          .filter((block) => block.type === 'text' && block.text.trim())
          .forEach((block) => system.push(block));
        break;

      case 'tool':
      case 'function':
        converted.push({
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: msg.tool_call_id || msg.name || 'tool_result',
            content: convertToolResultContent(msg.content),
          }],
        });
        break;

      case 'assistant': {
        const content = convertContent(msg.content);
        if (typeof msg.reasoning_content === 'string' && msg.reasoning_content) {
          // Round-tripped reasoning can't be replayed as a thinking block
          // without its signature, so it is deliberately dropped.
          Logger.debug('OpenAI compat: dropping assistant reasoning_content (not replayable)');
        }
        content.push(...convertToolCalls(msg.tool_calls));
        converted.push({ role: 'assistant', content });
        break;
      }

      default:
        converted.push({ role: 'user', content: convertContent(msg.content) });
    }
  });

  return { system, messages: normalizeMessages(converted, allowPrefill) };
}

function convertTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools
    .filter((tool) => tool && (tool.function || tool.name))
    .map((tool) => {
      const fn = tool.function || tool;
      const params = fn.parameters && typeof fn.parameters === 'object' ? fn.parameters : {};
      return {
        name: fn.name,
        description: fn.description || '',
        input_schema: { type: 'object', properties: {}, ...params },
      };
    })
    .filter((tool) => tool.name);
}

function convertToolChoice(choice, parallelToolCalls) {
  let converted = null;

  if (typeof choice === 'string') {
    if (choice === 'auto') converted = { type: 'auto' };
    else if (choice === 'required' || choice === 'any') converted = { type: 'any' };
    else if (choice === 'none') converted = { type: 'none' };
  } else if (choice && typeof choice === 'object') {
    const name = choice.function?.name || choice.name;
    if (name) converted = { type: 'tool', name };
  }

  if (parallelToolCalls === false) {
    converted = converted || { type: 'auto' };
    if (converted.type === 'auto' || converted.type === 'any') {
      converted.disable_parallel_tool_use = true;
    }
  }

  return converted;
}

/**
 * OpenAI chat-completions request -> Anthropic /v1/messages request.
 * Returns the Anthropic body plus the metadata the response side needs.
 */
function toAnthropicRequest(src = {}, options = {}) {
  const defaultModel = options.defaultModel || DEFAULT_MODEL;
  const defaultMaxTokens = options.defaultMaxTokens || DEFAULT_MAX_TOKENS;

  const { system, messages } = convertMessages(src.messages, options.allowPrefill === true);
  const model = resolveModel(src.model, defaultModel);

  // Built as a whitelist: Anthropic rejects unknown top-level fields, so
  // n / presence_penalty / frequency_penalty / logit_bias / seed / user and
  // friends are dropped simply by never being copied.
  const body = {
    model,
    max_tokens: src.max_tokens || src.max_completion_tokens || defaultMaxTokens,
    messages,
  };

  if (system.length) body.system = system;
  if (src.stream) body.stream = true;

  if (typeof src.temperature === 'number') {
    // OpenAI allows 0-2, Anthropic only 0-1.
    body.temperature = Math.max(0, Math.min(1, src.temperature));
    if (src.temperature > 1) {
      Logger.debug(`OpenAI compat: clamped temperature ${src.temperature} to ${body.temperature}`);
    }
  }
  if (typeof src.top_p === 'number') body.top_p = src.top_p;
  if (typeof src.top_k === 'number') body.top_k = src.top_k;

  const stop = src.stop || src.stop_sequences;
  if (typeof stop === 'string' && stop) {
    body.stop_sequences = [stop];
  } else if (Array.isArray(stop)) {
    const sequences = stop.filter((s) => typeof s === 'string' && s);
    if (sequences.length) body.stop_sequences = sequences;
  }

  const tools = convertTools(src.tools || src.functions);
  if (tools.length) {
    body.tools = tools;
    const toolChoice = convertToolChoice(src.tool_choice || src.function_call, src.parallel_tool_calls);
    if (toolChoice) body.tool_choice = toolChoice;
  }

  // An explicit Anthropic thinking block wins; otherwise fall back to
  // OpenAI's reasoning_effort.
  if (src.thinking && typeof src.thinking === 'object') {
    body.thinking = src.thinking;
  } else if (typeof src.reasoning_effort === 'string' && REASONING_BUDGETS[src.reasoning_effort]) {
    body.thinking = { type: 'enabled', budget_tokens: REASONING_BUDGETS[src.reasoning_effort] };
  }

  if (body.thinking && body.thinking.type === 'enabled') {
    // max_tokens must exceed the thinking budget, and Anthropic rejects
    // temperature/top_p/top_k alongside thinking.
    const budget = body.thinking.budget_tokens || REASONING_BUDGETS.medium;
    body.max_tokens = Math.max(body.max_tokens, budget + 1024);
    delete body.temperature;
    delete body.top_p;
    delete body.top_k;
  }

  // Anthropic has no response_format; nudge through system instead.
  const format = src.response_format?.type;
  if (format === 'json_object' || format === 'json_schema') {
    const schema = src.response_format?.json_schema?.schema;
    const instruction = schema
      ? `Respond with a single JSON object matching this schema, and nothing else:\n${JSON.stringify(schema)}`
      : 'Respond with a single valid JSON object and nothing else.';
    body.system = [...(body.system || []), { type: 'text', text: instruction }];
  }

  const meta = {
    requestedModel: src.model || model,
    model,
    stream: !!src.stream,
    includeUsage: !!src.stream_options?.include_usage,
    created: Math.floor(Date.now() / 1000),
    id: `chatcmpl-${Math.random().toString(36).slice(2, 12)}`,
  };

  return { body, meta };
}

function toOpenAIUsage(usage = {}) {
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheWrite = usage.cache_creation_input_tokens || 0;
  const promptTokens = (usage.input_tokens || 0) + cacheRead + cacheWrite;
  const completionTokens = usage.output_tokens || 0;

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    prompt_tokens_details: { cached_tokens: cacheRead },
  };
}

function openAIId(anthropicId, fallbackId) {
  if (typeof anthropicId === 'string' && anthropicId) {
    return `chatcmpl-${anthropicId.replace(/^msg_/, '')}`;
  }
  return fallbackId || `chatcmpl-${Math.random().toString(36).slice(2, 12)}`;
}

/** Anthropic message response -> OpenAI chat.completion object. */
function toOpenAIChatCompletion(response = {}, meta = {}) {
  let content = '';
  let reasoning = '';
  const toolCalls = [];

  (Array.isArray(response.content) ? response.content : []).forEach((block) => {
    if (!block) return;
    if (block.type === 'text') {
      content += block.text || '';
    } else if (block.type === 'thinking') {
      reasoning += block.thinking || '';
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
      });
    }
  });

  const message = { role: 'assistant', content: content || (toolCalls.length ? null : '') };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length) message.tool_calls = toolCalls;

  return {
    id: openAIId(response.id, meta.id),
    object: 'chat.completion',
    created: meta.created || Math.floor(Date.now() / 1000),
    model: response.model || meta.model || DEFAULT_MODEL,
    choices: [{
      index: 0,
      message,
      logprobs: null,
      finish_reason: FINISH_REASONS[response.stop_reason] || (toolCalls.length ? 'tool_calls' : 'stop'),
    }],
    usage: toOpenAIUsage(response.usage),
  };
}

/** Anthropic (or proxy) error payload -> OpenAI error envelope. */
function toOpenAIError(payload, statusCode = 500) {
  let parsed = payload;
  if (typeof payload === 'string') parsed = safeJsonParse(payload, null);

  const err = (parsed && typeof parsed === 'object' && parsed.error) || {};
  const message = err.message
    || (typeof parsed?.message === 'string' ? parsed.message : null)
    || (typeof payload === 'string' && payload.trim() ? payload.trim() : null)
    || 'Upstream request failed';

  return {
    error: {
      message,
      type: err.type || 'api_error',
      param: null,
      code: err.type || String(statusCode),
    },
  };
}

/**
 * Transform that rewrites an Anthropic SSE stream into OpenAI
 * chat.completion.chunk SSE, terminated with `data: [DONE]`.
 */
function createStreamTranslator(meta = {}) {
  const state = {
    id: meta.id || `chatcmpl-${Math.random().toString(36).slice(2, 12)}`,
    model: meta.model || DEFAULT_MODEL,
    created: meta.created || Math.floor(Date.now() / 1000),
    includeUsage: !!meta.includeUsage,
    blockTypes: new Map(), // content block index -> block type
    toolSlots: new Map(),  // content block index -> position in tool_calls
    toolCount: 0,
    stopReason: null,
    usage: {},
    finished: false,
  };

  let buffer = '';

  const encode = (payload) => `data: ${JSON.stringify(payload)}\n\n`;

  const chunk = (delta, finishReason = null) => encode({
    id: state.id,
    object: 'chat.completion.chunk',
    created: state.created,
    model: state.model,
    choices: [{ index: 0, delta, finish_reason: finishReason, logprobs: null }],
  });

  const finish = (push) => {
    if (state.finished) return;
    state.finished = true;

    push(chunk({}, FINISH_REASONS[state.stopReason] || (state.toolCount ? 'tool_calls' : 'stop')));

    // Per the OpenAI spec the usage chunk only appears when asked for.
    if (state.includeUsage) {
      push(encode({
        id: state.id,
        object: 'chat.completion.chunk',
        created: state.created,
        model: state.model,
        choices: [],
        usage: toOpenAIUsage(state.usage),
      }));
    }

    push('data: [DONE]\n\n');
  };

  const handleEvent = (event, push) => {
    switch (event.type) {
      case 'message_start': {
        const message = event.message || {};
        state.id = openAIId(message.id, state.id);
        if (message.model) state.model = message.model;
        Object.assign(state.usage, message.usage || {});
        push(chunk({ role: 'assistant', content: '' }));
        break;
      }

      case 'content_block_start': {
        const block = event.content_block || {};
        state.blockTypes.set(event.index, block.type);

        if (block.type === 'tool_use') {
          const slot = state.toolCount++;
          state.toolSlots.set(event.index, slot);
          push(chunk({
            tool_calls: [{
              index: slot,
              id: block.id,
              type: 'function',
              function: { name: block.name, arguments: '' },
            }],
          }));
        } else if (block.type === 'text' && block.text) {
          push(chunk({ content: block.text }));
        } else if (block.type === 'thinking' && block.thinking) {
          push(chunk({ reasoning_content: block.thinking }));
        }
        break;
      }

      case 'content_block_delta': {
        const delta = event.delta || {};
        if (delta.type === 'text_delta' && delta.text) {
          push(chunk({ content: delta.text }));
        } else if (delta.type === 'thinking_delta' && delta.thinking) {
          push(chunk({ reasoning_content: delta.thinking }));
        } else if (delta.type === 'input_json_delta') {
          const slot = state.toolSlots.get(event.index);
          if (slot !== undefined) {
            push(chunk({
              tool_calls: [{ index: slot, function: { arguments: delta.partial_json || '' } }],
            }));
          }
        }
        // signature_delta carries no client-visible content.
        break;
      }

      case 'message_delta':
        if (event.delta && event.delta.stop_reason) state.stopReason = event.delta.stop_reason;
        Object.assign(state.usage, event.usage || {});
        break;

      case 'message_stop':
        finish(push);
        break;

      case 'error':
        // Mid-stream failure: hand the client an OpenAI-shaped error, then close.
        push(encode(toOpenAIError(event, 500)));
        state.finished = true;
        push('data: [DONE]\n\n');
        break;

      default:
        break; // ping, and anything Anthropic adds later
    }
  };

  return new Transform({
    transform(input, encoding, callback) {
      buffer += input.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop();

      const push = (out) => this.push(out);
      lines.forEach((line) => {
        if (state.finished) return;
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) return;

        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') return;

        const event = safeJsonParse(payload, null);
        if (!event) {
          Logger.debug(`OpenAI compat: skipping unparsable SSE payload (${payload.length} bytes)`);
          return;
        }
        handleEvent(event, push);
      });

      callback();
    },

    flush(callback) {
      // Upstream can end without message_stop (client disconnect, truncation).
      finish((out) => this.push(out));
      callback();
    },
  });
}

/** OpenAI /v1/models payload. */
function toModelList(models = KNOWN_MODELS) {
  const created = Math.floor(Date.now() / 1000);
  return {
    object: 'list',
    data: models.map((id) => ({ id, object: 'model', created, owned_by: 'anthropic' })),
  };
}

function toModelObject(id) {
  return { id, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'anthropic' };
}

module.exports = {
  DEFAULT_MODEL,
  DEFAULT_MAX_TOKENS,
  KNOWN_MODELS,
  PLACEHOLDER_USER_TEXT,
  PLACEHOLDER_CONTINUE_TEXT,
  toAnthropicRequest,
  toOpenAIChatCompletion,
  toOpenAIError,
  toOpenAIUsage,
  createStreamTranslator,
  toModelList,
  toModelObject,
  resolveModel,
};
