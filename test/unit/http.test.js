import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpClient, redactUrl } from '../../src/providers/http.js';
import {
  NetworkError,
  RateLimitError,
  AuthError,
  ProviderError,
  TimeoutError,
} from '../../src/core/errors.js';
import { fakeFetch } from '../helpers.js';

test('http: parses a JSON body', async () => {
  const client = new HttpClient({ fetchImpl: fakeFetch({ example: { body: { ok: 1 } } }) });
  assert.deepEqual(await client.getJson('https://example.invalid/x'), { ok: 1 });
});

test('http: an empty body is an error, not silently empty data', async () => {
  const client = new HttpClient({ fetchImpl: fakeFetch({ example: { body: '   ' } }) });
  await assert.rejects(() => client.getJson('https://example.invalid/x'), ProviderError);
});

test('http: malformed JSON is reported as unreadable, not thrown raw', async () => {
  const client = new HttpClient({ fetchImpl: fakeFetch({ example: { body: '<html>oops' } }) });
  await assert.rejects(
    () => client.getJson('https://example.invalid/x', { retries: 0 }),
    (error) => {
      assert.ok(error instanceof ProviderError);
      assert.match(error.userMessage, /unreadable/);
      return true;
    },
  );
});

test('http: 429 becomes a rate-limit error after exhausting retries', async () => {
  const fetchImpl = fakeFetch({
    example: { status: 429, headers: { 'retry-after': '0' }, body: { error: 'slow down' } },
  });
  const client = new HttpClient({ fetchImpl });
  await assert.rejects(
    () => client.get('https://example.invalid/x', { retries: 1 }),
    RateLimitError,
  );
  assert.equal(fetchImpl.calls.length, 2, 'a rate limit is retried once');
});

test('http: 401 is an auth error and is never retried', async () => {
  const fetchImpl = fakeFetch({ example: { status: 401, body: {} } });
  const client = new HttpClient({ fetchImpl });
  await assert.rejects(() => client.get('https://example.invalid/x', { retries: 3 }), AuthError);
  assert.equal(fetchImpl.calls.length, 1, 'bad credentials will not fix themselves');
});

test('http: 404 is final', async () => {
  const fetchImpl = fakeFetch({ example: { status: 404, body: {} } });
  const client = new HttpClient({ fetchImpl });
  await assert.rejects(
    () => client.get('https://example.invalid/x', { retries: 3 }),
    ProviderError,
  );
  assert.equal(fetchImpl.calls.length, 1);
});

test('http: a 5xx is retried and then succeeds', async () => {
  const fetchImpl = fakeFetch({
    example: [
      { status: 503, body: {} },
      { status: 200, body: { recovered: true } },
    ],
  });
  const client = new HttpClient({ fetchImpl });
  const payload = await client.getJson('https://example.invalid/x', { retries: 2 });
  assert.deepEqual(payload, { recovered: true });
  assert.equal(fetchImpl.calls.length, 2);
});

test('http: a DNS failure becomes a friendly network error', async () => {
  const error = new Error('fetch failed');
  error.cause = { code: 'ENOTFOUND' };
  const client = new HttpClient({ fetchImpl: fakeFetch({ example: { throws: error } }) });
  await assert.rejects(
    () => client.get('https://example.invalid/x', { retries: 0 }),
    (thrown) => {
      assert.ok(thrown instanceof NetworkError);
      assert.equal(thrown.userMessage, 'Network unavailable');
      assert.match(thrown.hint, /internet connection/);
      return true;
    },
  );
});

test('http: a timeout is reported as a timeout', async () => {
  const client = new HttpClient({
    timeoutMs: 40,
    fetchImpl: fakeFetch({ example: { delayMs: 500, body: {} } }),
  });
  await assert.rejects(
    () => client.get('https://example.invalid/x', { retries: 0 }),
    (error) => {
      assert.ok(error instanceof TimeoutError);
      return true;
    },
  );
});

test('http: a caller-supplied abort stays an abort so the UI can ignore it', async () => {
  const controller = new AbortController();
  const client = new HttpClient({
    fetchImpl: fakeFetch({ example: { delayMs: 500, body: {} } }),
  });
  const promise = client.get('https://example.invalid/x', {
    signal: controller.signal,
    retries: 0,
  });
  controller.abort(new DOMException('superseded', 'AbortError'));
  await assert.rejects(promise, (error) => {
    assert.equal(error.name, 'AbortError');
    return true;
  });
});

test('http: sends a descriptive User-Agent with an optional contact', async () => {
  const fetchImpl = fakeFetch({ example: { body: {} } });
  const client = new HttpClient({ fetchImpl, contact: 'me@example.invalid' });
  await client.get('https://example.invalid/x');
  const ua = fetchImpl.calls[0].options.headers['user-agent'];
  assert.match(ua, /Termify/);
  assert.match(ua, /me@example\.invalid/);
});

test('http: the client-side throttle spaces requests out', async () => {
  const fetchImpl = fakeFetch({ example: { body: {} } });
  const client = new HttpClient({ fetchImpl, minIntervalMs: 60 });
  const started = Date.now();
  await client.get('https://example.invalid/1');
  await client.get('https://example.invalid/2');
  assert.ok(Date.now() - started >= 55, 'the second call waited its turn');
});

test('http: redactUrl hides credentials before anything is logged', () => {
  assert.equal(
    redactUrl('https://api.example.invalid/tracks?client_id=SECRET&limit=5'),
    'https://api.example.invalid/tracks?client_id=redacted&limit=5',
  );
  assert.equal(redactUrl('not a url'), 'not a url');
});
