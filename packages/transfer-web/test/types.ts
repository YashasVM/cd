import { CdTransferClient, TransferError, type TransferSink, type VerifiedFile } from '../src/index.js';
const client = new CdTransferClient({ appId: 'com.example.host' });
const sink: TransferSink = { write(bytes, signal) { bytes.byteLength; signal.aborted; }, commit(file) { file.sha256; }, abort() {} };
const outgoing = client.outgoing(new File(['hello'], 'hello.txt'), { lifetimeMs: 60_000, onUpdate(update) { update.state; } });
const result: Promise<VerifiedFile> = outgoing.run(invitation => {
  const incoming = client.incoming(invitation);
  void incoming.run(async (offer, signal) => { offer.sha256; signal.aborted; return sink; });
  incoming.cancel();
});
void result.catch((error: unknown) => { if (error instanceof TransferError) error.state; });
// @ts-expect-error A host sink must implement cleanup.
const unsafeSink: TransferSink = { write() {}, commit() {} };
void unsafeSink;
