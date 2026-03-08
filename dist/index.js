'use strict';

/**
 * Builds a standardised HTTP response object for API Gateway.
 *
 * @param {number} statusCode - HTTP status code.
 * @param {object} body       - Response body (will be JSON-serialised).
 * @returns {object} API Gateway proxy response.
 */
const buildResponse = (statusCode, body) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(body),
});

/**
 * AWS Lambda handler.
 *
 * Responds to API Gateway proxy events with a simple greeting.
 * Extend this function with your own business logic.
 *
 * @param {object} event   - API Gateway event object.
 * @param {object} context - Lambda context object.
 * @returns {Promise<object>} API Gateway proxy response.
 */
const handler = async (event, context) => {
  try {
    // eslint-disable-next-line no-console
    console.log('Event received1:', JSON.stringify(event, null, 2));
    // eslint-disable-next-line no-console
    console.log('Request ID:', context.awsRequestId);

    const name = event?.queryStringParameters?.name || 'World';

    return buildResponse(200, {
      message: `Hello, ${name}!`,
      timestamp: new Date().toISOString(),
      requestId: context.awsRequestId,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Unexpected error:', err);

    return buildResponse(500, {
      error: 'Internal Server Error',
      message: err.message,
    });
  }
};

module.exports = { handler, buildResponse };
