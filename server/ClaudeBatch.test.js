const nock = require('nock');

// Mock Logger before requiring ClaudeRequest
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

const ClaudeRequest = require('./ClaudeRequest');

const SPOOF_TEXT = 'You are Claude Code';

function makeBatchBody() {
  return {
    requests: [
      {
        custom_id: 'st-req-1',
        params: {
          model: 'claude-fable-5',
          max_tokens: 100,
          messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
          stream: true, // must be stripped by createBatch
        },
      },
    ],
  };
}

describe('ClaudeRequest batch methods', () => {
  beforeEach(() => {
    ClaudeRequest.cachedToken = null;
    ClaudeRequest.cachedTokenIsApiKey = false;
    ClaudeRequest.presetCache.clear();
  });

  afterEach(() => {
    nock.cleanAll();
    jest.restoreAllMocks();
  });

  describe('createBatch', () => {
    it('strips stream, injects the Claude Code system prompt into each params, and forwards to /v1/messages/batches', async () => {
      let captured = null;
      nock('https://api.anthropic.com')
        .post('/v1/messages/batches', (body) => { captured = body; return true; })
        .reply(200, { id: 'msgbatch_abc', processing_status: 'in_progress' });

      const cr = new ClaudeRequest();
      jest.spyOn(cr, 'getAuthToken').mockResolvedValue('Bearer oauth-token');

      const result = await cr.createBatch(makeBatchBody(), null);

      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body).id).toBe('msgbatch_abc');

      expect(captured.requests).toHaveLength(1);
      const params = captured.requests[0].params;
      expect('stream' in params).toBe(false);
      // processRequestBody unshifts the spoof system block
      expect(params.system[0].text).toContain(SPOOF_TEXT);
    });

    it('uses x-api-key with NO oauth beta when the token is a real API key', async () => {
      let sentHeaders = null;
      nock('https://api.anthropic.com')
        .post('/v1/messages/batches')
        .reply(function () {
          sentHeaders = this.req.headers;
          return [200, { id: 'msgbatch_key', processing_status: 'in_progress' }];
        });

      // Simulate the sk-ant passthrough from the constructor
      const cr = new ClaudeRequest({ headers: { 'x-api-key': 'sk-ant-test123' } });

      await cr.createBatch(makeBatchBody(), null);

      expect(String(sentHeaders['x-api-key'])).toBe('sk-ant-test123');
      expect(sentHeaders['authorization']).toBeUndefined();
      const beta = String(sentHeaders['anthropic-beta']);
      expect(beta).not.toContain('oauth-2025-04-20');
      expect(beta).not.toContain('claude-code');
    });

    it('sends the oauth betas (and Authorization) when using an OAuth token', async () => {
      let sentHeaders = null;
      nock('https://api.anthropic.com')
        .post('/v1/messages/batches')
        .reply(function () {
          sentHeaders = this.req.headers;
          return [200, { id: 'msgbatch_oauth' }];
        });

      const cr = new ClaudeRequest();
      jest.spyOn(cr, 'getAuthToken').mockResolvedValue('Bearer oauth-token');

      await cr.createBatch(makeBatchBody(), null);

      expect(String(sentHeaders['authorization'])).toBe('Bearer oauth-token');
      expect(sentHeaders['x-api-key']).toBeUndefined();
      expect(String(sentHeaders['anthropic-beta'])).toContain('oauth-2025-04-20');
    });
  });

  describe('retrieveBatch / cancelBatch', () => {
    it('retrieves batch status by id', async () => {
      nock('https://api.anthropic.com')
        .get('/v1/messages/batches/msgbatch_abc')
        .reply(200, { id: 'msgbatch_abc', processing_status: 'ended', results_url: 'https://api.anthropic.com/v1/messages/batches/msgbatch_abc/results' });

      const cr = new ClaudeRequest();
      jest.spyOn(cr, 'getAuthToken').mockResolvedValue('Bearer oauth-token');

      const result = await cr.retrieveBatch('msgbatch_abc');
      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body).processing_status).toBe('ended');
    });

    it('cancels a batch by id', async () => {
      nock('https://api.anthropic.com')
        .post('/v1/messages/batches/msgbatch_abc/cancel')
        .reply(200, { id: 'msgbatch_abc', processing_status: 'canceling' });

      const cr = new ClaudeRequest();
      jest.spyOn(cr, 'getAuthToken').mockResolvedValue('Bearer oauth-token');

      const result = await cr.cancelBatch('msgbatch_abc');
      expect(JSON.parse(result.body).processing_status).toBe('canceling');
    });
  });

  describe('getBatchResults', () => {
    it('follows results_url and returns the JSONL body', async () => {
      const jsonl = JSON.stringify({ custom_id: 'st-req-1', result: { type: 'succeeded', message: { content: [{ type: 'text', text: 'hi' }] } } });

      nock('https://api.anthropic.com')
        .get('/v1/messages/batches/msgbatch_abc')
        .reply(200, { id: 'msgbatch_abc', processing_status: 'ended', results_url: 'https://api.anthropic.com/v1/messages/batches/msgbatch_abc/results' })
        .get('/v1/messages/batches/msgbatch_abc/results')
        .reply(200, jsonl);

      const cr = new ClaudeRequest();
      jest.spyOn(cr, 'getAuthToken').mockResolvedValue('Bearer oauth-token');

      const result = await cr.getBatchResults('msgbatch_abc');
      expect(result.statusCode).toBe(200);
      expect(result.body).toContain('succeeded');
    });

    it('returns 409 when results are not ready yet', async () => {
      nock('https://api.anthropic.com')
        .get('/v1/messages/batches/msgbatch_pending')
        .reply(200, { id: 'msgbatch_pending', processing_status: 'in_progress', results_url: null });

      const cr = new ClaudeRequest();
      jest.spyOn(cr, 'getAuthToken').mockResolvedValue('Bearer oauth-token');

      const result = await cr.getBatchResults('msgbatch_pending');
      expect(result.statusCode).toBe(409);
      expect(JSON.parse(result.body).processing_status).toBe('in_progress');
    });
  });

  describe('countTokens', () => {
    it('forwards the body verbatim to /v1/messages/count_tokens and returns input_tokens', async () => {
      let captured = null;
      nock('https://api.anthropic.com')
        .post('/v1/messages/count_tokens', (body) => { captured = body; return true; })
        .reply(200, { input_tokens: 14 });

      const cr = new ClaudeRequest();
      jest.spyOn(cr, 'getAuthToken').mockResolvedValue('Bearer oauth-token');

      const result = await cr.countTokens({
        model: 'claude-opus-5',
        messages: [{ role: 'user', content: 'Hello, Claude' }],
      });

      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body).input_tokens).toBe(14);
      expect(captured.model).toBe('claude-opus-5');
      expect(captured.messages).toHaveLength(1);
    });

    it('does NOT inject the Claude Code system prompt', async () => {
      // Counting happens per prompt fragment, so a spoof block would add its own
      // tokens to every single fragment SillyTavern asks about.
      let captured = null;
      nock('https://api.anthropic.com')
        .post('/v1/messages/count_tokens', (body) => { captured = body; return true; })
        .reply(200, { input_tokens: 5 });

      const cr = new ClaudeRequest();
      jest.spyOn(cr, 'getAuthToken').mockResolvedValue('Bearer oauth-token');

      await cr.countTokens({
        model: 'claude-opus-5',
        messages: [{ role: 'user', content: 'hi' }],
      });

      expect(captured.system).toBeUndefined();
    });

    it('uses x-api-key with no oauth betas when given a real API key', async () => {
      let sentHeaders = null;
      nock('https://api.anthropic.com')
        .post('/v1/messages/count_tokens')
        .reply(function () {
          sentHeaders = this.req.headers;
          return [200, { input_tokens: 7 }];
        });

      const cr = new ClaudeRequest({ headers: { 'x-api-key': 'sk-ant-test123' } });

      await cr.countTokens({
        model: 'claude-fable-5',
        messages: [{ role: 'user', content: 'hi' }],
      });

      expect(String(sentHeaders['x-api-key'])).toBe('sk-ant-test123');
      expect(sentHeaders['authorization']).toBeUndefined();
      expect(String(sentHeaders['anthropic-beta'])).not.toContain('oauth-2025-04-20');
    });
  });
});
