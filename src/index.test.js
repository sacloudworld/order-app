'use strict';

const { handler, buildResponse } = require('./index');

// ─── Mock context object (simulates Lambda runtime context) ──────────────────
const mockContext = {
  awsRequestId: 'test-request-id-1234',
  functionName: 'cicd-pipeline-lambda',
  functionVersion: '$LATEST',
  invokedFunctionArn: 'arn:aws:lambda:us-east-1:123456789012:function:cicd-pipeline-lambda',
};

// ─── buildResponse ────────────────────────────────────────────────────────────
describe('buildResponse', () => {
  it('should return a correctly structured API Gateway response', () => {
    const response = buildResponse(200, { message: 'ok' });

    expect(response).toEqual({
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'ok' }),
    });
  });

  it('should serialise the body to JSON', () => {
    const body = { foo: 'bar', count: 42 };
    const response = buildResponse(201, body);

    expect(typeof response.body).toBe('string');
    expect(JSON.parse(response.body)).toEqual(body);
  });

  it('should forward the status code unchanged', () => {
    expect(buildResponse(404, {}).statusCode).toBe(404);
    expect(buildResponse(500, {}).statusCode).toBe(500);
  });
});

// ─── handler ─────────────────────────────────────────────────────────────────
describe('handler', () => {
  it('should return 200 with "Hello, World!" when no name is provided', async () => {
    const event = {};
    const response = await handler(event, mockContext);

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.message).toBe('Hello, World!');
    expect(body.requestId).toBe(mockContext.awsRequestId);
    expect(body.timestamp).toBeDefined();
  });

  it('should return 200 with a personalised greeting when name is provided', async () => {
    const event = {
      queryStringParameters: { name: 'Alice' },
    };
    const response = await handler(event, mockContext);

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.message).toBe('Hello, Alice!');
  });

  it('should include a valid ISO timestamp in the response body', async () => {
    const response = await handler({}, mockContext);
    const body = JSON.parse(response.body);

    expect(() => new Date(body.timestamp)).not.toThrow();
    expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);
  });

  it('should return 500 when an unexpected error is thrown', async () => {
    // Force an error by passing a getter that throws
    const badEvent = {
      get queryStringParameters() {
        throw new Error('Simulated internal error');
      },
    };

    const response = await handler(badEvent, mockContext);

    expect(response.statusCode).toBe(500);
    const body = JSON.parse(response.body);
    expect(body.error).toBe('Internal Server Error');
    expect(body.message).toBe('Simulated internal error');
  });
});
