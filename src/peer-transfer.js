import peerjs from 'peerjs';
import { isTransferId } from './transfer-utils.js';

const { Peer } = peerjs;

export const transferLimits = {
  maxFiles: 100,
  maxFileBytes: 512 * 1024 * 1024,
  maxTransferBytes: 2 * 1024 * 1024 * 1024,
};

const CHUNK_BYTES = 64 * 1024;
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const PROGRESS_INTERVAL_MS = 100;

export const fileSummary = files => files.map(({ name, size, type }) => ({ name, size, ...(type ? { mime: type } : {}) }));
export const errorText = error => typeof error === 'string' ? error : error?.type || error?.message || 'unknown error';

export function openPeer() {
  return new Promise((resolve, reject) => {
    const peer = new Peer({ debug: 1 });
    const onError = error => { clearTimeout(timer); peer.off('open', onOpen); peer.destroy(); reject(error); };
    const onOpen = () => { clearTimeout(timer); peer.off('error', onError); resolve(peer); };
    const timer = setTimeout(() => { peer.off('error', onError); peer.off('open', onOpen); peer.destroy(); reject(new Error('signaling timed out')); }, 15000);
    peer.once('open', onOpen);
    peer.once('error', onError);
  });
}

const isControl = data => data && typeof data === 'object'
  && !(data instanceof ArrayBuffer)
  && !(globalThis.Blob && data instanceof Blob)
  && !ArrayBuffer.isView(data)
  && typeof data.type === 'string';

export function validateManifest(files) {
  if (!Array.isArray(files) || !files.length || files.length > transferLimits.maxFiles) {
    throw new Error(`Transfers must contain 1–${transferLimits.maxFiles} files.`);
  }
  let total = 0;
  for (const file of files) {
    if (!file || typeof file.name !== 'string' || !file.name.trim() || file.name.length > 255
      || /[\\/\u0000-\u001f\u007f]/.test(file.name) || (file.mime !== undefined && (typeof file.mime !== 'string' || file.mime.length > 255))
      || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > transferLimits.maxFileBytes) {
      throw new Error('The sender provided an invalid file manifest.');
    }
    total += file.size;
  }
  if (total > transferLimits.maxTransferBytes) throw new Error('This transfer exceeds the 2 GB session limit.');
  return total;
}

export const validateFiles = files => validateManifest(fileSummary(files));

const wait = delay => new Promise(resolve => setTimeout(resolve, delay));

async function waitForBufferCapacity(connection, hasFailed) {
  const channel = connection.dataChannel;
  if (!channel) return;

  while (!hasFailed() && channel.bufferedAmount > MAX_BUFFERED_BYTES) {
    await wait(40);
  }
}

function createProgressEmitter(emit) {
  let lastEmit = 0;
  let pending;

  return {
    update(state) {
      const now = performance.now();
      if (now - lastEmit >= PROGRESS_INTERVAL_MS) {
        lastEmit = now;
        emit(state);
      } else {
        pending = state;
      }
    },
    flush() {
      if (pending) emit(pending);
      pending = undefined;
    },
  };
}

export async function sendFiles(connection, files, handlers = {}) {
  const emit = state => {
    if (typeof handlers === 'function') handlers(state.message);
    else handlers.state?.(state);
  };
  const total = validateManifest(fileSummary(files));
  let sent = 0;
  let finished = false;
  let awaitingReceipt = false;
  let failure;
  let resolveOutcome;
  const outcome = new Promise(resolve => { resolveOutcome = resolve; });
  const progress = createProgressEmitter(emit);
  const fail = error => {
    if (finished || failure) return;
    failure = error instanceof Error ? error : new Error(errorText(error));
    resolveOutcome({ error: failure });
  };
  const onData = data => {
    if (awaitingReceipt && isControl(data) && data.type === 'receipt') {
      finished = true;
      resolveOutcome({ received: true });
    } else if (isControl(data) && data.type === 'cancel') fail(new Error('The recipient cancelled the transfer.'));
  };
  const onError = error => fail(new Error(`Connection failed: ${errorText(error)}`));
  const onClose = () => fail(new Error('The connection closed before the recipient gave the thumbs-up.'));
  connection.on('data', onData);
  connection.on('error', onError);
  connection.on('close', onClose);

  try {
    connection.send({ type: 'manifest', files: fileSummary(files) });
    for (const [index, file] of files.entries()) {
      if (failure) throw failure;
      connection.send({ type: 'file-start', index });
      for (let offset = 0; offset < file.size; offset += CHUNK_BYTES) {
        if (failure) throw failure;
        await waitForBufferCapacity(connection, () => Boolean(failure));
        if (failure) throw failure;
        const chunk = await file.slice(offset, offset + CHUNK_BYTES).arrayBuffer();
        connection.send(chunk);
        sent += chunk.byteLength;
        const percent = total ? Math.round(sent / total * 100) : 100;
        progress.update({ phase: 'transferring', progress: percent, message: `Sending ${percent}%` });
      }
      connection.send({ type: 'file-complete' });
    }
    awaitingReceipt = true;
    progress.flush();
    connection.send({ type: 'transfer-complete' });
    emit({ phase: 'waiting', progress: 100, message: 'Sent. Waiting for receiver thumbs-up…' });
    const timeout = setTimeout(() => fail(new Error('No thumbs-up yet. Try the transfer again.')), 30000);
    const result = await outcome;
    clearTimeout(timeout);
    if (result.error) throw result.error;
    emit({ phase: 'completed', progress: 100, message: 'Delivered. Thumbs-up received.' });
    connection.close();
    return { ok: true };
  } catch (error) {
    emit({ phase: 'failed', progress: total ? Math.round(sent / total * 100) : 0, message: errorText(error) });
    connection.close();
    return { ok: false, error };
  } finally {
    connection.off?.('data', onData);
    connection.off?.('error', onError);
    connection.off?.('close', onClose);
  }
}

export function receiveFiles(peerId, handlers = {}, PeerClass = Peer) {
  const emit = state => { handlers.state?.(state); handlers.status?.(state.message); };
  if (!isTransferId(peerId)) {
    const state = { phase: 'failed', progress: 0, message: 'That transfer code is a dud.' };
    handlers.state?.(state);
    handlers.status?.(state.message);
    return { cancel() {}, destroy() {} };
  }
  const peer = new PeerClass({ debug: 1 });
  let connection;
  let manifest;
  let expectedTotal = 0;
  let received = 0;
  let current;
  let completed = 0;
  let finished = false;
  let queue = Promise.resolve();
  let timeout;

  const resetTimeout = (delay = 30000) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => fail('The transfer stalled. Ask the sender to try again.'), delay);
  };
  const close = () => {
    clearTimeout(timeout);
    connection?.close();
    peer.destroy();
  };
  const fail = message => {
    if (finished) return;
    finished = true;
    emit({ phase: 'failed', progress: expectedTotal ? Math.round(received / expectedTotal * 100) : 0, message: errorText(message) });
    close();
  };
  const cancel = () => {
    if (finished) return;
    finished = true;
    connection?.send({ type: 'cancel' });
    emit({ phase: 'cancelled', progress: expectedTotal ? Math.round(received / expectedTotal * 100) : 0, message: 'Transfer cancelled.' });
    close();
  };
  const destroy = () => {
    finished = true;
    close();
  };

  const consume = async data => {
    if (finished) return;
    resetTimeout();
    if (!isControl(data)) {
      if (!current) throw new Error('Received file data before a file was announced.');
      const chunk = globalThis.Blob && data instanceof Blob ? await data.arrayBuffer()
        : ArrayBuffer.isView(data) ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data;
      if (finished) return;
      if (!(chunk instanceof ArrayBuffer) || current.received + chunk.byteLength > current.file.size) {
        throw new Error('Received more data than the file manifest declared.');
      }
      current.received += chunk.byteLength;
      received += chunk.byteLength;
      current.chunks.push(chunk);
      handlers.progress?.(received, expectedTotal);
      emit({ phase: 'transferring', progress: expectedTotal ? Math.round(received / expectedTotal * 100) : 0, message: `Receiving ${expectedTotal ? Math.round(received / expectedTotal * 100) : 0}%` });
      return;
    }

    if (data.type === 'manifest') {
      if (manifest) throw new Error('Received more than one file manifest.');
      expectedTotal = validateManifest(data.files);
      manifest = data.files;
      handlers.manifest?.(manifest);
      return;
    }
    if (data.type === 'file-start') {
      if (!manifest || current || data.index !== completed || !manifest[data.index]) throw new Error('Files arrived out of order.');
      current = { index: data.index, file: manifest[data.index], chunks: [], received: 0 };
      return;
    }
    if (data.type === 'file-complete') {
      if (!current || current.received !== current.file.size) throw new Error('A file ended before all of its data arrived.');
      const blob = new Blob(current.chunks, { type: current.file.mime });
      const url = URL.createObjectURL(blob);
      if (handlers.file) handlers.file({ index: current.index, file: current.file, url });
      else {
        Object.assign(document.createElement('a'), { href: url, download: current.file.name }).click();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      }
      completed += 1;
      current = undefined;
      return;
    }
    if (data.type === 'transfer-complete') {
      if (!manifest || current || completed !== manifest.length || received !== expectedTotal) throw new Error('The transfer ended before every file arrived.');
      connection.send({ type: 'receipt' });
      finished = true;
      clearTimeout(timeout);
      emit({ phase: 'completed', progress: 100, message: 'All here. Nice.' });
      handlers.complete?.();
      setTimeout(close, 250);
      return;
    }
    if (data.type === 'cancel') return fail('The sender cancelled the transfer.');
    throw new Error('Received an unknown transfer message.');
  };

  resetTimeout(20000);
  emit({ phase: 'connecting', progress: 0, message: 'Finding the sender…' });
  peer.on('open', () => {
    connection = peer.connect(peerId, { reliable: true });
    connection.on('open', () => { resetTimeout(); emit({ phase: 'waiting', progress: 0, message: 'Connected. Waiting for the stuff…' }); });
    connection.on('data', data => { queue = queue.then(() => consume(data)).catch(fail); });
    connection.on('error', error => fail(`Transfer failed: ${errorText(error)}`));
    connection.on('close', () => { queue.finally(() => { if (!finished) fail('The sender vanished before delivery.'); }); });
  });
  peer.on('error', error => fail(`Connection failed: ${errorText(error)}`));
  return { cancel, destroy, peer };
}
