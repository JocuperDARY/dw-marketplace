import { createHash } from 'node:crypto';

const MAX_CHARACTERS = 1048576;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const positiveInteger = value => Number.isSafeInteger(value) && value > 0;
const TERMINAL = new Set(['completed', 'paused', 'failed', 'cancelled', 'timed_out', 'cleanup_failed', 'interrupted', 'state_write_failed']);
const truncationFlag = values => values.includes(true) ? true : values.includes(false) ? false : null;

export class ResultReadError extends Error {
  constructor(code, message, { category = 'read', partial, result, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ResultReadError';
    this.code = code;
    this.category = category;
    if (partial) this.partial = partial;
    if (result) this.result = result;
  }
}

function unwrap(response) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw new ResultReadError('INVALID_PAGE', 'dsh_result did not return an object.');
  }
  let page = response;
  if (Object.hasOwn(response, 'content') || Object.hasOwn(response, 'structuredContent')) {
    page = response.structuredContent;
    if (page === undefined) {
      if (!Array.isArray(response.content) || response.content.length !== 1 || response.content[0].type !== 'text') {
        throw new ResultReadError('INVALID_PAGE', 'Expected one MCP JSON text block or structuredContent.');
      }
      try { page = JSON.parse(response.content[0].text); }
      catch { throw new ResultReadError('INVALID_PAGE', 'The MCP page envelope is not JSON.'); }
    }
  }
  if (response.isError === true || (page?.error && !Object.hasOwn(page, 'resultAvailable'))) {
    // The original safe bridge code remains available to the caller. Never retry,
    // continue, or call another tool because an observation failed.
    const code = typeof page?.error?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(page.error.code) ? page.error.code : 'TOOL_ERROR';
    throw new ResultReadError('RESULT_READ_FAILED', `dsh_result failed (${code}).`, { cause: page?.error });
  }
  if (!page || typeof page !== 'object' || Array.isArray(page)) {
    throw new ResultReadError('INVALID_PAGE', 'The page envelope must contain an object.');
  }
  return page;
}

/** Read one immutable attempt via existing dsh_result calls. No model calls or retries.
 * callTool accepts the same request object as MCP Client.callTool. A local adapter
 * may instead return the unwrapped TaskManager.result object.
 */
export async function readCompleteResult(callTool, { taskId, attempt, limit = 16000, parseJson = false } = {}) {
  if (typeof callTool !== 'function' || typeof taskId !== 'string' || !UUID.test(taskId)
    || (attempt !== undefined && !positiveInteger(attempt)) || !positiveInteger(limit) || limit > 32000
    || typeof parseJson !== 'boolean') {
    throw new ResultReadError('INVALID_ARGUMENT', 'Supply a task UUID, optional positive attempt, and page limit 1–32000.', { category: 'input' });
  }
  const chunks = [];
  let offset = 0;
  let pinned;
  let receipt;
  try {
    do {
      let response;
      try {
        response = await callTool({ name: 'dsh_result', arguments: { taskId,
          ...(attempt === undefined ? {} : { attempt }), offset, limit } });
      } catch (cause) {
        throw new ResultReadError('RESULT_READ_FAILED', 'dsh_result transport or observation failed.', { cause });
      }
      const page = unwrap(response);
      if (page.resultAvailable !== true) throw new ResultReadError('RESULT_UNAVAILABLE', 'The saved result is unavailable.');
      const meta = page.resultPage;
      if (page.taskId !== taskId || !positiveInteger(page.number) || (attempt !== undefined && page.number !== attempt)
        || typeof page.sessionId !== 'string' || !page.sessionId || typeof page.requestId !== 'string' || !page.requestId
        || !TERMINAL.has(page.status)
        || !meta || meta.unit !== 'utf16-code-units' || !Number.isSafeInteger(meta.totalCharacters)
        || meta.totalCharacters < 0 || meta.totalCharacters > MAX_CHARACTERS
        || typeof meta.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(meta.sha256)) {
        throw new ResultReadError('INVALID_PAGE', 'The result identity, terminal status, or page metadata is invalid.');
      }
      const identity = JSON.stringify([page.taskId, page.sessionId, page.number, page.requestId, page.status,
        page.output ?? null, page.outputTruncated ?? null, meta]);
      if (pinned !== undefined && pinned !== identity) throw new ResultReadError('RESULT_CHANGED', 'The attempt identity or saved result changed during retrieval.');
      pinned = identity;
      attempt = page.number;
      const end = offset + (typeof page.text === 'string' ? page.text.length : 0);
      if (page.offset !== offset || typeof page.text !== 'string' || page.text.length > limit
        || end > meta.totalCharacters || (end < meta.totalCharacters
          ? page.text.length === 0 || page.nextOffset !== end : page.nextOffset !== null)) {
        throw new ResultReadError('INVALID_PAGE', 'The page offset, text length, or nextOffset does not match its boundaries.');
      }
      chunks.push(page.text);
      // Exclude the page text from the final receipt; the assembled text is separate.
      const { text: ignored, ...evidence } = page;
      receipt = evidence;
      offset = page.nextOffset;
    } while (offset !== null);
    const text = chunks.join('');
    if (createHash('sha256').update(text, 'utf8').digest('hex') !== receipt.resultPage.sha256) {
      throw new ResultReadError('RESULT_DIGEST_MISMATCH', 'The assembled saved result does not match its SHA-256.');
    }
    const result = { text, receipt, retrieval: { complete: true, pages: chunks.length,
      characters: text.length, unit: 'utf16-code-units', sha256: receipt.resultPage.sha256 },
      truncation: { model: truncationFlag([receipt.output?.modelTruncated]),
        storage: truncationFlag([receipt.outputTruncated, receipt.output?.storageTruncated]) } };
    if (parseJson) {
      if (result.truncation.model || result.truncation.storage) {
        throw new ResultReadError('RESULT_TRUNCATED', 'All saved pages were read, but the model or storage clipped the result.', { category: 'content', result });
      }
      try { result.json = JSON.parse(text); }
      catch { throw new ResultReadError('INVALID_JSON', 'The complete saved result is not valid JSON.', { category: 'content', result }); }
      if (result.json === null || typeof result.json !== 'object' || Array.isArray(result.json)) {
        throw new ResultReadError('INVALID_JSON_OBJECT', 'The complete saved JSON must have an object root.', { category: 'content', result });
      }
    }
    return result;
  } catch (error) {
    if (error instanceof ResultReadError && error.category === 'read') {
      error.partial = { text: chunks.join(''), pages: chunks.length, characters: chunks.reduce((sum, chunk) => sum + chunk.length, 0),
        attempt: attempt ?? null, complete: false };
    }
    throw error;
  }
}
