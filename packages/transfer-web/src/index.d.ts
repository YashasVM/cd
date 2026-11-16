export type TransferState = 'connecting' | 'waiting' | 'awaiting-consent' | 'transferring' | 'verifying' | 'complete' | 'rejected' | 'expired' | 'cancelled' | 'failed' | 'recoverable-failure';
export interface TransferUpdate { state: TransferState; bytes: number; total: number }
export interface VerifiedFile { size: number; sha256: string }
/** Public, unverified attribution. Never use appId for authorization. */
export interface TransferOffer extends VerifiedFile { name: string; expiresAt: number; appId?: string }
/** Own each chunk before write resolves; stage privately until commit. Honor AbortSignal. */
export interface TransferSink {
  write(bytes: Uint8Array, signal: AbortSignal): void | Promise<void>;
  commit(file: VerifiedFile, signal: AbortSignal): void | Promise<void>;
  abort(): void | Promise<void>;
}
export interface TransferOptions { onUpdate?: (update: TransferUpdate) => void }
export interface OutgoingTransfer {
  readonly state: TransferState;
  readonly signal: AbortSignal;
  run(onReady: (invitation: string) => void): Promise<VerifiedFile>;
  cancel(): void;
}
export interface IncomingTransfer {
  readonly state: TransferState;
  readonly signal: AbortSignal;
  /** Return null to reject. Resolve only after explicit user consent. */
  run(onOffer: (offer: TransferOffer, signal: AbortSignal) => TransferSink | null | Promise<TransferSink | null>): Promise<VerifiedFile>;
  cancel(): void;
}
export class TransferError extends Error { readonly state: TransferState; constructor(state: TransferState, cause?: unknown) }
export class CdTransferClient {
  constructor(options: { appId: string; relayOrigin?: string });
  outgoing(file: File, options?: TransferOptions & { lifetimeMs?: number }): OutgoingTransfer;
  incoming(invitation: string, options?: TransferOptions): IncomingTransfer;
}
