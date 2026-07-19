const nock = require('nock');
const { PassThrough } = require('stream');

// Mock Logger before requiring ClaudeRequest
jest.mock('./Logger', () => ({
  info: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  init: jest.fn(),
  getLogLevel: jest.fn().mockReturnValue(0),
  createDebugStream: jest.fn()
}));

const ClaudeRequest = require('./ClaudeRequest');

const SPOOF_TEXT = 'You are Claude Code';

function createMockRes() {
  const res = new PassThrough();
  res.statusCode = null;
  res.headers = {};
  res.setHeader = (key, value) => { res.headers[key] = value; };
  res.getHeaders = () => res.headers;
  res.removeHeader = (key) => { delete res.headers[key]; };
  res.headersSent = false;
  // Swallow the piped/ended response body; tests only inspect outgoing requests
  res.resume();
  return res;
}

function makeClientBody() {
  return {
    model: 'claude-fable-5',
    system: [
      {
        type: 'text',
        text: 'Roleplay system prompt',
        cache_control: { type: 'ephemeral', ttl: '5m' }
      }
    ],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] }
    ],
    max_tokens: 100,
    stream: false
  };
}

describe('ClaudeRequest 401 retry', () => {
  beforeEach(() => {
    ClaudeRequest.cachedToken = null;
    ClaudeRequest.cachedTokenIsApiKey = false;
    ClaudeRequest.presetCache.clear();
  });

  afterEach(() => {
    nock.cleanAll();
    jest.restoreAllMocks();
  });

  it('sends a byte-identical body on the 401 retry (no duplicated spoof block)', async () => {
    const capturedBodies = [];
    const capture = (body) => { capturedBodies.push(JSON.stringify(body)); return true; };

    nock('https://api.anthropic.com')
      .post('/v1/messages', capture)
      .reply(401, { error: { type: 'authentication_error' } })
      .post('/v1/messages', capture)
      .reply(200, { content: [{ type: 'text', text: 'ok' }] });

    const cr = new ClaudeRequest();
    jest.spyOn(cr, 'loadOrRefreshToken').mockResolvedValue('Bearer fresh-token');

    const res = createMockRes();
    await cr.handleResponse(res, makeClientBody(), null);

    expect(capturedBodies).toHaveLength(2);
    expect(capturedBodies[1]).toBe(capturedBodies[0]);

    const sent = JSON.parse(capturedBodies[1]);
    const spoofBlocks = sent.system.filter(b => b.text && b.text.includes(SPOOF_TEXT));
    expect(spoofBlocks).toHaveLength(1);
    expect(sent.system[0].text).toContain(SPOOF_TEXT);
    // Client's cache breakpoint survives, still on the block after the spoof
    expect(sent.system[1].cache_control).toEqual({ type: 'ephemeral', ttl: '5m' });
    expect(sent.messages).toHaveLength(1);
  });

  it('does not duplicate the preset suffix message on the 401 retry', async () => {
    ClaudeRequest.presetCache.set('testpreset', {
      system: 'PRESET SYSTEM',
      suffix: 'PRESET SUFFIX',
      suffixEt: 'PRESET SUFFIX ET'
    });

    const capturedBodies = [];
    const capture = (body) => { capturedBodies.push(JSON.stringify(body)); return true; };

    nock('https://api.anthropic.com')
      .post('/v1/messages', capture)
      .reply(401, { error: { type: 'authentication_error' } })
      .post('/v1/messages', capture)
      .reply(200, { content: [{ type: 'text', text: 'ok' }] });

    const cr = new ClaudeRequest();
    jest.spyOn(cr, 'loadOrRefreshToken').mockResolvedValue('Bearer fresh-token');

    const res = createMockRes();
    await cr.handleResponse(res, makeClientBody(), 'testpreset');

    expect(capturedBodies).toHaveLength(2);
    expect(capturedBodies[1]).toBe(capturedBodies[0]);

    const sent = JSON.parse(capturedBodies[1]);
    // system: spoof + client system + preset system, exactly once each
    expect(sent.system).toHaveLength(3);
    const suffixMessages = sent.messages.filter(m =>
      Array.isArray(m.content) && m.content.some(c => c.text === 'PRESET SUFFIX')
    );
    expect(suffixMessages).toHaveLength(1);
  });

  it('uses suffixEt for adaptive thinking models', () => {
    ClaudeRequest.presetCache.set('testpreset', {
      suffix: 'PRESET SUFFIX',
      suffixEt: 'PRESET SUFFIX ET'
    });

    const cr = new ClaudeRequest();
    const body = makeClientBody();
    body.thinking = { type: 'adaptive' };

    const processed = cr.processRequestBody(body, 'testpreset');

    const texts = processed.messages.flatMap(m =>
      Array.isArray(m.content) ? m.content.map(c => c.text) : []
    );
    expect(texts).toContain('PRESET SUFFIX ET');
    expect(texts).not.toContain('PRESET SUFFIX');
  });
});
