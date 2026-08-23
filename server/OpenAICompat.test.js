const nock = require('nock');
const { PassThrough } = require('stream');

// Mock Logger before requiring anything that touches it
jest.mock('./Logger', () => ({
  info: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  init: jest.fn(),
  getLogLevel: jest.fn().mockReturnValue(0),
  createDebugStream: jest.fn(),
  truncate: (v) => String(v),
}));

const OpenAICompat = require('./OpenAICompat');
const ClaudeRequest = require('./ClaudeRequest');

const SPOOF_TEXT = 'You are Claude Code';

function createMockRes() {
  const res = new PassThrough();
  res.statusCode = 200;
  res.headers = {};
  res.headersSent = false;
  res.setHeader = (key, value) => { res.headers[key.toLowerCase()] = value; };
  res.getHeader = (key) => res.headers[key.toLowerCase()];
  res.getHeaders = () => res.headers;
  res.removeHeader = (key) => { delete res.headers[key.toLowerCase()]; };
  res.writeHead = (code, headers) => {
    res.statusCode = code;
    Object.entries(headers || {}).forEach(([k, v]) => { res.headers[k.toLowerCase()] = v; });
    res.headersSent = true;
    return res;
  };

  res.body = '';
  res.on('data', (chunk) => { res.body += chunk.toString(); });
  res.done = new Promise((resolve) => res.on('end', resolve));
  return res;
}

const SSE_TEXT_STREAM = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_01ABC","type":"message","role":"assistant","model":"claude-sonnet-5","content":[],"usage":{"input_tokens":10,"cache_read_input_tokens":5,"output_tokens":1}}}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  '',
  'event: ping',
  'data: {"type":"ping"}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}',
  '',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":0}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
].join('\n');

function parseSSE(raw) {
  return raw
    .split('\n\n')
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => block.replace(/^data:\s*/, ''));
}

async function runTranslator(meta, chunks) {
  const translator = OpenAICompat.createStreamTranslator(meta);
  let out = '';
  translator.on('data', (chunk) => { out += chunk.toString(); });
  const finished = new Promise((resolve) => translator.on('end', resolve));

  chunks.forEach((chunk) => translator.write(chunk));
  translator.end();
  await finished;
  return out;
}

describe('OpenAICompat.toAnthropicRequest', () => {
  it('hoists system/developer messages out of the message list', () => {
    const { body } = OpenAICompat.toAnthropicRequest({
      model: 'claude-sonnet-5',
      messages: [
        { role: 'system', content: 'You are a shopkeeper.' },
        { role: 'developer', content: 'Stay in character.' },
        { role: 'user', content: 'Hello there' },
      ],
    });

    expect(body.system).toEqual([
      { type: 'text', text: 'You are a shopkeeper.' },
      { type: 'text', text: 'Stay in character.' },
    ]);
    expect(body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Hello there' }] },
    ]);
  });

  it('supplies max_tokens when the client omits it, and honours max_completion_tokens', () => {
    const { body } = OpenAICompat.toAnthropicRequest({ messages: [{ role: 'user', content: 'hi' }] });
    expect(body.max_tokens).toBe(OpenAICompat.DEFAULT_MAX_TOKENS);

    const { body: capped } = OpenAICompat.toAnthropicRequest({
      messages: [{ role: 'user', content: 'hi' }],
      max_completion_tokens: 512,
    });
    expect(capped.max_tokens).toBe(512);
  });

  it('passes Claude model names through and maps OpenAI names to a Claude model', () => {
    expect(OpenAICompat.resolveModel('claude-opus-5')).toBe('claude-opus-5');
    expect(OpenAICompat.resolveModel('gpt-4')).toBe('claude-opus-5');
    expect(OpenAICompat.resolveModel('some-local-model', 'claude-sonnet-5')).toBe('claude-sonnet-5');
    expect(OpenAICompat.resolveModel(undefined, 'claude-fable-5')).toBe('claude-fable-5');
  });

  it('drops OpenAI-only sampling fields that Anthropic rejects', () => {
    const { body } = OpenAICompat.toAnthropicRequest({
      messages: [{ role: 'user', content: 'hi' }],
      n: 3,
      presence_penalty: 0.5,
      frequency_penalty: 0.5,
      logit_bias: { 1234: -100 },
      seed: 42,
      user: 'player-1',
      logprobs: true,
    });

    ['n', 'presence_penalty', 'frequency_penalty', 'logit_bias', 'seed', 'user', 'logprobs']
      .forEach((key) => expect(body[key]).toBeUndefined());
  });

  it('clamps temperature into Anthropic range and converts stop to stop_sequences', () => {
    const { body } = OpenAICompat.toAnthropicRequest({
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 1.8,
      stop: '\nPlayer:',
    });

    expect(body.temperature).toBe(1);
    expect(body.stop_sequences).toEqual(['\nPlayer:']);

    const { body: multi } = OpenAICompat.toAnthropicRequest({
      messages: [{ role: 'user', content: 'hi' }],
      stop: ['END', ''],
    });
    expect(multi.stop_sequences).toEqual(['END']);
  });

  it('merges consecutive same-role turns and forces a leading user turn', () => {
    const { body } = OpenAICompat.toAnthropicRequest({
      messages: [
        { role: 'assistant', content: 'The tavern is quiet.' },
        { role: 'user', content: 'Look around' },
        { role: 'user', content: 'Carefully' },
      ],
    });

    expect(body.messages[0].role).toBe('user');
    expect(body.messages[0].content[0].text).toBe(OpenAICompat.PLACEHOLDER_USER_TEXT);
    expect(body.messages[1].role).toBe('assistant');
    expect(body.messages[2]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'Look around' }, { type: 'text', text: 'Carefully' }],
    });
  });

  it('closes a conversation that ends on an assistant turn with a user turn', () => {
    // Opus 4.6+ rejects assistant prefill outright, and OpenAI semantics treat a
    // trailing assistant message as history rather than something to continue.
    const { body } = OpenAICompat.toAnthropicRequest({
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Can you put my foot back on?' },
      ],
    });

    expect(body.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(body.messages[2].content).toEqual([{ type: 'text', text: OpenAICompat.PLACEHOLDER_CONTINUE_TEXT }]);
  });

  it('handles an assistant-only history (state kept in system messages)', () => {
    // The shape MyRobot sends: everything in system, one assistant turn, no user turn.
    const { body } = OpenAICompat.toAnthropicRequest({
      model: 'claude-opus-4-6',
      messages: [
        { role: 'system', content: 'You are a cute robot.' },
        { role: 'system', content: 'Speak to this person.' },
        { role: 'assistant', content: 'Thank you for cleaning my foot!' },
      ],
    });

    expect(body.model).toBe('claude-opus-4-6');
    expect(body.system).toHaveLength(2);
    expect(body.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(body.messages[0].content[0].text).toBe(OpenAICompat.PLACEHOLDER_USER_TEXT);
    expect(body.messages[2].content[0].text).toBe(OpenAICompat.PLACEHOLDER_CONTINUE_TEXT);
  });

  it('leaves a trailing user turn alone', () => {
    const { body } = OpenAICompat.toAnthropicRequest({
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi!' },
        { role: 'user', content: 'How are you?' },
      ],
    });
    expect(body.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(body.messages[2].content[0].text).toBe('How are you?');
  });

  it('does not append after tool results, which already end on a user turn', () => {
    const { body } = OpenAICompat.toAnthropicRequest({
      messages: [
        { role: 'user', content: 'weather?' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'w', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: 'clear' },
      ],
    });

    expect(body.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(body.messages[2].content[0].type).toBe('tool_result');
  });

  it('drops empty turns, and keeps prefill (whitespace-trimmed) when allowPrefill is set', () => {
    const { body } = OpenAICompat.toAnthropicRequest({
      messages: [
        { role: 'user', content: 'Continue' },
        { role: 'assistant', content: '   ' },
        { role: 'user', content: '' },
        { role: 'assistant', content: 'She said: ' },
      ],
    }, { allowPrefill: true });

    expect(body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Continue' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'She said:' }] },
    ]);
  });

  it('converts multimodal parts, including data-url images', () => {
    const { body } = OpenAICompat.toAnthropicRequest({
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'What is this?' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
          { type: 'input_audio', input_audio: { data: 'xx' } },
        ],
      }],
    });

    expect(body.messages[0].content).toEqual([
      { type: 'text', text: 'What is this?' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    ]);
  });

  it('converts tools, tool calls and tool results', () => {
    const { body } = OpenAICompat.toAnthropicRequest({
      messages: [
        { role: 'user', content: 'weather?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Whiterun"}' },
          }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'clear skies' },
      ],
      tools: [{
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Look up weather',
          parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
        },
      }],
      tool_choice: 'required',
    });

    expect(body.tools).toEqual([{
      name: 'get_weather',
      description: 'Look up weather',
      input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    }]);
    expect(body.tool_choice).toEqual({ type: 'any' });

    expect(body.messages[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Whiterun' } }],
    });
    expect(body.messages[2]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'clear skies' }],
    });
  });

  it('maps reasoning_effort onto a thinking budget and clears sampling params', () => {
    const { body } = OpenAICompat.toAnthropicRequest({
      messages: [{ role: 'user', content: 'hi' }],
      reasoning_effort: 'high',
      temperature: 0.7,
      max_tokens: 1000,
    });

    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 16384 });
    expect(body.max_tokens).toBeGreaterThan(16384);
    expect(body.temperature).toBeUndefined();
  });

  it('turns response_format json into a system instruction', () => {
    const { body } = OpenAICompat.toAnthropicRequest({
      messages: [{ role: 'user', content: 'hi' }],
      response_format: { type: 'json_object' },
    });

    expect(body.response_format).toBeUndefined();
    expect(body.system[body.system.length - 1].text).toMatch(/JSON/i);
  });
});

describe('OpenAICompat response translation', () => {
  it('converts an Anthropic message into a chat.completion', () => {
    const completion = OpenAICompat.toOpenAIChatCompletion({
      id: 'msg_01XYZ',
      model: 'claude-sonnet-5',
      content: [
        { type: 'thinking', thinking: 'considering' },
        { type: 'text', text: 'Hello ' },
        { type: 'text', text: 'traveller.' },
      ],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, cache_read_input_tokens: 4, output_tokens: 6 },
    }, { created: 1700000000 });

    expect(completion.object).toBe('chat.completion');
    expect(completion.id).toBe('chatcmpl-01XYZ');
    expect(completion.model).toBe('claude-sonnet-5');
    expect(completion.choices[0].message.content).toBe('Hello traveller.');
    expect(completion.choices[0].message.reasoning_content).toBe('considering');
    expect(completion.choices[0].finish_reason).toBe('stop');
    expect(completion.usage).toEqual({
      prompt_tokens: 14,
      completion_tokens: 6,
      total_tokens: 20,
      prompt_tokens_details: { cached_tokens: 4 },
    });
  });

  it('converts tool_use blocks into tool_calls with finish_reason tool_calls', () => {
    const completion = OpenAICompat.toOpenAIChatCompletion({
      id: 'msg_02',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Riften' } }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 5, output_tokens: 2 },
    }, {});

    expect(completion.choices[0].finish_reason).toBe('tool_calls');
    expect(completion.choices[0].message.content).toBeNull();
    expect(completion.choices[0].message.tool_calls).toEqual([{
      id: 'toolu_1',
      type: 'function',
      function: { name: 'get_weather', arguments: '{"city":"Riften"}' },
    }]);
  });

  it('maps max_tokens to finish_reason length', () => {
    const completion = OpenAICompat.toOpenAIChatCompletion({
      content: [{ type: 'text', text: 'truncated' }],
      stop_reason: 'max_tokens',
    }, {});
    expect(completion.choices[0].finish_reason).toBe('length');
  });

  it('reshapes Anthropic errors into the OpenAI error envelope', () => {
    const err = OpenAICompat.toOpenAIError({
      type: 'error',
      error: { type: 'invalid_request_error', message: 'max_tokens is required' },
    }, 400);

    expect(err).toEqual({
      error: {
        message: 'max_tokens is required',
        type: 'invalid_request_error',
        param: null,
        code: 'invalid_request_error',
      },
    });

    const raw = OpenAICompat.toOpenAIError('upstream exploded', 502);
    expect(raw.error.message).toBe('upstream exploded');
    expect(raw.error.code).toBe('502');
  });
});

describe('OpenAICompat.createStreamTranslator', () => {
  it('rewrites Anthropic SSE into OpenAI chunks ending in [DONE]', async () => {
    // Split mid-line to exercise the partial-line buffer
    const half = Math.floor(SSE_TEXT_STREAM.length / 2);
    const raw = await runTranslator({ model: 'claude-sonnet-5', created: 1700000000 }, [
      SSE_TEXT_STREAM.slice(0, half),
      SSE_TEXT_STREAM.slice(half),
    ]);

    const events = parseSSE(raw);
    expect(events[events.length - 1]).toBe('[DONE]');

    const chunks = events.slice(0, -1).map((e) => JSON.parse(e));
    chunks.forEach((chunk) => {
      expect(chunk.object).toBe('chat.completion.chunk');
      expect(chunk.id).toBe('chatcmpl-01ABC');
      expect(chunk.model).toBe('claude-sonnet-5');
    });

    expect(chunks[0].choices[0].delta).toEqual({ role: 'assistant', content: '' });
    expect(chunks.map((c) => c.choices[0]?.delta?.content).filter(Boolean).join('')).toBe('Hello world');
    expect(chunks[chunks.length - 1].choices[0].finish_reason).toBe('stop');
  });

  it('emits a usage chunk only when stream_options.include_usage is set', async () => {
    const without = parseSSE(await runTranslator({}, [SSE_TEXT_STREAM]));
    expect(without.slice(0, -1).map((e) => JSON.parse(e)).some((c) => c.usage)).toBe(false);

    const withUsage = parseSSE(await runTranslator({ includeUsage: true }, [SSE_TEXT_STREAM]));
    const usageChunk = withUsage.slice(0, -1).map((e) => JSON.parse(e)).find((c) => c.usage);
    expect(usageChunk.choices).toEqual([]);
    expect(usageChunk.usage).toEqual({
      prompt_tokens: 15,
      completion_tokens: 7,
      total_tokens: 22,
      prompt_tokens_details: { cached_tokens: 5 },
    });
  });

  it('streams tool calls with incremental argument deltas', async () => {
    const sse = [
      'data: {"type":"message_start","message":{"id":"msg_t","model":"claude-sonnet-5","usage":{"input_tokens":1}}}',
      '',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_9","name":"cast_spell","input":{}}}',
      '',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"spell\\":"}}',
      '',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"fireball\\"}"}}',
      '',
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":9}}',
      '',
      'data: {"type":"message_stop"}',
      '',
    ].join('\n');

    const chunks = parseSSE(await runTranslator({}, [sse])).slice(0, -1).map((e) => JSON.parse(e));
    const toolChunks = chunks.filter((c) => c.choices[0]?.delta?.tool_calls);

    expect(toolChunks[0].choices[0].delta.tool_calls[0]).toEqual({
      index: 0,
      id: 'toolu_9',
      type: 'function',
      function: { name: 'cast_spell', arguments: '' },
    });
    expect(toolChunks.slice(1).map((c) => c.choices[0].delta.tool_calls[0].function.arguments).join(''))
      .toBe('{"spell":"fireball"}');
    expect(chunks[chunks.length - 1].choices[0].finish_reason).toBe('tool_calls');
  });

  it('emits reasoning_content for thinking deltas', async () => {
    const sse = [
      'data: {"type":"message_start","message":{"id":"msg_r","model":"claude-opus-5"}}',
      '',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
      '',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}}',
      '',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"abc"}}',
      '',
      'data: {"type":"message_stop"}',
      '',
    ].join('\n');

    const chunks = parseSSE(await runTranslator({}, [sse])).slice(0, -1).map((e) => JSON.parse(e));
    expect(chunks.map((c) => c.choices[0]?.delta?.reasoning_content).filter(Boolean).join('')).toBe('hmm');
  });

  it('closes out the stream when upstream ends without message_stop', async () => {
    const sse = [
      'data: {"type":"message_start","message":{"id":"msg_cut","model":"claude-sonnet-5"}}',
      '',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}',
      '',
    ].join('\n');

    const events = parseSSE(await runTranslator({}, [sse]));
    expect(events[events.length - 1]).toBe('[DONE]');
    expect(JSON.parse(events[events.length - 2]).choices[0].finish_reason).toBe('stop');
  });
});

describe('ClaudeRequest.handleOpenAIResponse', () => {
  beforeEach(() => {
    ClaudeRequest.cachedToken = null;
    ClaudeRequest.cachedTokenIsApiKey = false;
    ClaudeRequest.presetCache.clear();
  });

  afterEach(() => {
    nock.cleanAll();
    jest.restoreAllMocks();
  });

  it('sends an Anthropic body upstream and returns a chat.completion', async () => {
    let captured = null;
    nock('https://api.anthropic.com')
      .post('/v1/messages', (body) => { captured = body; return true; })
      .reply(200, {
        id: 'msg_int',
        model: 'claude-sonnet-5',
        content: [{ type: 'text', text: 'Greetings.' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 12, output_tokens: 3 },
      }, { 'content-type': 'application/json' });

    const cr = new ClaudeRequest();
    jest.spyOn(cr, 'getAuthToken').mockResolvedValue('Bearer oauth-token');

    const res = createMockRes();
    await cr.handleOpenAIResponse(res, {
      model: 'gpt-4',
      messages: [
        { role: 'system', content: 'You are a guard.' },
        { role: 'user', content: 'Halt!' },
      ],
      temperature: 0.8,
    }, null);
    await res.done;

    // Upstream still gets a plain Anthropic request, spoof block first
    expect(captured.system[0].text).toContain(SPOOF_TEXT);
    expect(captured.system[1].text).toBe('You are a guard.');
    expect(captured.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'Halt!' }] }]);
    expect(captured.model).toBe('claude-opus-5'); // gpt-4 alias
    expect(captured.max_tokens).toBeDefined();

    // Client gets OpenAI shape back
    const payload = JSON.parse(res.body);
    expect(payload.object).toBe('chat.completion');
    expect(payload.choices[0].message.content).toBe('Greetings.');
    expect(payload.choices[0].finish_reason).toBe('stop');
    expect(payload.usage.total_tokens).toBe(15);
  });

  it('applies presets on the OpenAI route too', async () => {
    ClaudeRequest.presetCache.set('testpreset', {
      system: 'PRESET SYSTEM',
      suffix: 'PRESET SUFFIX',
      suffixEt: 'PRESET SUFFIX ET',
    });

    let captured = null;
    nock('https://api.anthropic.com')
      .post('/v1/messages', (body) => { captured = body; return true; })
      .reply(200, { id: 'msg_p', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' },
        { 'content-type': 'application/json' });

    const cr = new ClaudeRequest();
    jest.spyOn(cr, 'getAuthToken').mockResolvedValue('Bearer oauth-token');

    const res = createMockRes();
    await cr.handleOpenAIResponse(res, { messages: [{ role: 'user', content: 'hi' }] }, 'testpreset');
    await res.done;

    expect(captured.system.map((b) => b.text)).toContain('PRESET SYSTEM');
    const texts = captured.messages.flatMap((m) => m.content.map((c) => c.text));
    expect(texts).toContain('PRESET SUFFIX');
  });

  it('translates a streaming response into OpenAI chunks', async () => {
    nock('https://api.anthropic.com')
      .post('/v1/messages')
      .reply(200, SSE_TEXT_STREAM, { 'content-type': 'text/event-stream' });

    const cr = new ClaudeRequest();
    jest.spyOn(cr, 'getAuthToken').mockResolvedValue('Bearer oauth-token');

    const res = createMockRes();
    await cr.handleOpenAIResponse(res, {
      model: 'gpt-4o',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    }, null);
    await res.done;

    expect(res.headers['content-type']).toBe('text/event-stream');
    const events = parseSSE(res.body);
    expect(events[events.length - 1]).toBe('[DONE]');

    const chunks = events.slice(0, -1).map((e) => JSON.parse(e));
    expect(chunks[0].object).toBe('chat.completion.chunk');
    expect(chunks.map((c) => c.choices[0]?.delta?.content).filter(Boolean).join('')).toBe('Hello world');
  });

  it('drops the upstream content-length so the rewritten body is not truncated', async () => {
    const upstream = JSON.stringify({
      id: 'msg_len',
      content: [{ type: 'text', text: 'x' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    nock('https://api.anthropic.com')
      .post('/v1/messages')
      .reply(200, upstream, {
        'content-type': 'application/json',
        'content-length': String(upstream.length),
      });

    const cr = new ClaudeRequest();
    jest.spyOn(cr, 'getAuthToken').mockResolvedValue('Bearer oauth-token');

    const res = createMockRes();
    await cr.handleOpenAIResponse(res, { messages: [{ role: 'user', content: 'hi' }] }, null);
    await res.done;

    expect(res.headers['content-length']).toBeUndefined();
    expect(JSON.parse(res.body).object).toBe('chat.completion');
  });

  it('returns upstream errors in the OpenAI error envelope', async () => {
    nock('https://api.anthropic.com')
      .post('/v1/messages')
      .reply(400, { type: 'error', error: { type: 'invalid_request_error', message: 'bad model' } },
        { 'content-type': 'application/json' });

    const cr = new ClaudeRequest();
    jest.spyOn(cr, 'getAuthToken').mockResolvedValue('Bearer oauth-token');

    const res = createMockRes();
    await cr.handleOpenAIResponse(res, { messages: [{ role: 'user', content: 'hi' }] }, null);
    await res.done;

    expect(res.statusCode).toBe(400);
    const payload = JSON.parse(res.body);
    expect(payload.error.message).toBe('bad model');
    expect(payload.error.type).toBe('invalid_request_error');
  });

  it('leaves the Anthropic route untouched (no OpenAI translation)', async () => {
    nock('https://api.anthropic.com')
      .post('/v1/messages')
      .reply(200, { id: 'msg_native', content: [{ type: 'text', text: 'native' }] },
        { 'content-type': 'application/json' });

    const cr = new ClaudeRequest();
    jest.spyOn(cr, 'getAuthToken').mockResolvedValue('Bearer oauth-token');

    const res = createMockRes();
    await cr.handleResponse(res, {
      model: 'claude-sonnet-5',
      max_tokens: 10,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    }, null);
    await res.done;

    const payload = JSON.parse(res.body);
    expect(payload.id).toBe('msg_native');
    expect(payload.object).toBeUndefined();
  });
});

describe('ClaudeRequest auth from Authorization header', () => {
  beforeEach(() => {
    ClaudeRequest.cachedToken = null;
    ClaudeRequest.cachedTokenIsApiKey = false;
  });

  it('accepts a real Anthropic API key sent as a bearer token', () => {
    new ClaudeRequest({ headers: { authorization: 'Bearer sk-ant-api03-real' } });
    expect(ClaudeRequest.cachedToken).toBe('Bearer sk-ant-api03-real');
    expect(ClaudeRequest.cachedTokenIsApiKey).toBe(true);
  });

  it('ignores placeholder bearer keys so the OAuth path still runs', () => {
    new ClaudeRequest({ headers: { authorization: 'Bearer sk-1234567890' } });
    expect(ClaudeRequest.cachedToken).toBeNull();
    expect(ClaudeRequest.cachedTokenIsApiKey).toBe(false);
  });

  it('ignores an OAuth access token in the Authorization header', () => {
    new ClaudeRequest({ headers: { authorization: 'Bearer sk-ant-oat01-token' } });
    expect(ClaudeRequest.cachedTokenIsApiKey).toBe(false);
  });
});
