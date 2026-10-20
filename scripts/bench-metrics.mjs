export function summarize(trials) {
  const complete = trials.filter((trial) => trial.completed);
  const median = (key) => {
    const values = complete.map((trial) => trial[key]).filter(Number.isFinite).sort((a, b) => a - b);
    const factor = key === 'seconds' ? 10000 : 100;
    return values.length ? Math.round(values[Math.floor(values.length / 2)] * factor) / factor : null;
  };
  return { runs: trials.length, completed: complete.length, completionRate: complete.length / trials.length,
    readinessMs: median('readinessMs'), parentExitMs: median('parentExitMs'),
    seconds: median('seconds'), mibPerSecond: median('mibPerSecond'),
    outputBytes: median('outputBytes'), trials };
}


// Serialized into each browser context before app code runs. Counts only
// successful sends and complete encrypted payload records, including records
// split across negotiated data-channel pieces. It retains at most 12 header
// bytes per transport, never a copy of file contents.
export function browserTransportProbe(options = {}) {
  const stats = window.__benchTransport = {
    directBytes: 0, directPayloadBytes: 0, relayBytes: 0, relayPayloadBytes: 0,
    directReceivedBytes: 0, directReceivedPayloadBytes: 0, relayReceivedBytes: 0, relayReceivedPayloadBytes: 0,
    legacyBytes: 0, maxDirectBufferedBytes: 0, maxRelayBufferedBytes: 0,
    firstPayloadRoute: null, routes: [], successfulDirectPieces: 0, webSocketExtensions: []
  };
  stats.engineMaxima = {};
  window.__CD_TRANSFER_TEST_OBSERVER__ = (snapshot) => {
    for (const [key, value] of Object.entries(snapshot)) {
      if (typeof value === 'number' && Number.isFinite(value)) stats.engineMaxima[key] = Math.max(stats.engineMaxima[key] ?? 0, value);
    }
    if (snapshot.window) for (const [key, value] of Object.entries(snapshot.window)) {
      if (typeof value === 'number' && Number.isFinite(value)) stats.engineMaxima[`window_${key}`] = Math.max(stats.engineMaxima[`window_${key}`] ?? 0, value);
    }
  };
  stats.maxJSHeapBytes = globalThis.performance?.memory?.usedJSHeapSize ?? null;
  const sampleHeap = () => { if (globalThis.performance?.memory) stats.maxJSHeapBytes = Math.max(stats.maxJSHeapBytes ?? 0, globalThis.performance.memory.usedJSHeapSize); };
  const streams = new WeakMap();
  const inboundStreams = new WeakMap();
  let sawRelayPayload;
  const firstRelayPayload = new Promise(resolve => { sawRelayPayload = resolve; });
  function countRecord(target, data, route, inbound = false) {
    const parserStates = inbound ? inboundStreams : streams;
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data)
      : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null;
    if (!bytes) return;
    let state = parserStates.get(target);
    if (!state) { state = { header: [], remaining: 0, payload: 0 }; parserStates.set(target, state); }
    let cursor = 0;
    while (cursor < bytes.length) {
      if (!state.remaining) {
        while (state.header.length < 12 && cursor < bytes.length) state.header.push(bytes[cursor++]);
        if (state.header.length < 12) break;
        if (state.header[0] !== 0x43 || state.header[1] !== 0x44 || state.header[2] !== 1) throw new Error('transport probe observed unencrypted direct framing');
        const length = new DataView(Uint8Array.from(state.header).buffer).getUint32(8);
        if (length > 1024 * 1024) throw new Error('transport probe observed oversized record');
        state.remaining = length + 16;
        state.payload = state.header[3] === 2 || state.header[3] === 8 ? length : 0;
        state.header = [];
      }
      const copied = Math.min(state.remaining, bytes.length - cursor);
      state.remaining -= copied;
      cursor += copied;
      if (!state.remaining && state.payload) {
        stats[`${route}PayloadBytes`] += state.payload;
        stats[`${route}FirstPayloadAt`] ??= Date.now();
        stats[`${route}LastPayloadAt`] = Date.now();
        if (route === 'relay' || route === 'relayReceived') sawRelayPayload();
        stats.firstPayloadRoute ??= route;
        if (stats.routes.at(-1) !== route) stats.routes.push(route);
      }
    }
  }
  const nativeChannelSend = RTCDataChannel.prototype.send;
  RTCDataChannel.prototype.send = function(data) {
    const result = nativeChannelSend.call(this, data);
    sampleHeap();
    const size = data.byteLength ?? data.size ?? 0;
    if (this.label === 'cd-direct') {
      stats.directBytes += size;
      stats.successfulDirectPieces += 1;
      stats.maxDirectBufferedBytes = Math.max(stats.maxDirectBufferedBytes, this.bufferedAmount);
      countRecord(this, data, 'direct');
    } else stats.legacyBytes += size;
    return result;
  };
  const nativeSocketSend = WebSocket.prototype.send;
  WebSocket.prototype.send = function(data) {
    const result = nativeSocketSend.call(this, data);
    sampleHeap();
    if (typeof data !== 'string' && new URL(this.url).pathname.startsWith('/ws/v1/')) {
      stats.relayBytes += data.byteLength ?? data.size ?? 0;
      stats.maxRelayBufferedBytes = Math.max(stats.maxRelayBufferedBytes, this.bufferedAmount);
      countRecord(this, data, 'relay');
    }
    return result;
  };
  stats.peerStates = [];
  if (globalThis.RTCPeerConnection) {
    const nativeCreateChannel = RTCPeerConnection.prototype.createDataChannel;
    RTCPeerConnection.prototype.createDataChannel = function(...args) {
      const channel = nativeCreateChannel.apply(this, args);
      const peer = this;
      const state = { label: channel.label, connection: peer.connectionState, ice: peer.iceConnectionState, channel: channel.readyState };
      stats.peerStates.push(state);
      const update = () => { state.connection = peer.connectionState; state.ice = peer.iceConnectionState; state.channel = channel.readyState; };
      peer.addEventListener('connectionstatechange', update);
      peer.addEventListener('iceconnectionstatechange', update);
      channel.addEventListener('open', update);
      channel.addEventListener('close', update);
      if (channel.label === 'cd-direct') channel.addEventListener('message', (event) => {
        sampleHeap();
        stats.directReceivedBytes += event.data.byteLength ?? event.data.size ?? 0;
        countRecord(channel, event.data, 'directReceived', true);
      });
      return channel;
    };
  }
  const NativeSocket = WebSocket;
  window.WebSocket = class extends NativeSocket {
    constructor(...args) {
      super(...args);
      if (new URL(this.url).pathname.startsWith('/ws/v1/')) this.addEventListener('open',()=>stats.webSocketExtensions.push(this.extensions),{once:true});
      if (new URL(this.url).pathname.startsWith('/ws/v1/')) this.addEventListener('message', (event) => {
        if (typeof event.data === 'string') return;
        sampleHeap();
        stats.relayReceivedBytes += event.data.byteLength ?? event.data.size ?? 0;
        countRecord(this, event.data, 'relayReceived', true);
      });
    }
  };
  delete window.showSaveFilePicker;
  if (options.blockDirect) {
    window.RTCPeerConnection = function() { throw new Error('Direct connections blocked by verification'); };
  } else if (options.directDelayMs) {
    // Hold the receiver's answer until real relay payload has arrived.
    // An offer-time delay can finish before acceptance and never test upgrade.
    const nativeAnswer = RTCPeerConnection.prototype.createAnswer;
    RTCPeerConnection.prototype.createAnswer = async function(...args) {
      await firstRelayPayload;
      await new Promise((resolve) => setTimeout(resolve, options.directDelayMs));
      return nativeAnswer.apply(this, args);
    };
  }
  if (options.decryptDelayMs) {
    const nativeDecrypt = SubtleCrypto.prototype.decrypt;
    SubtleCrypto.prototype.decrypt = async function(...args) {
      await new Promise((resolve) => setTimeout(resolve, options.decryptDelayMs));
      return nativeDecrypt.apply(this, args);
    };
  }
}
