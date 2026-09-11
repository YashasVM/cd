import { DurableObject } from 'cloudflare:workers';

export interface Env {
  ASSETS: Fetcher;
  TRANSFERS: DurableObjectNamespace<TransferRoom>;
}

export class TransferRoom extends DurableObject<Env> {
  private sender: WebSocket | null = null;
  private receiver: WebSocket | null = null;

  fetch(request: Request): Response {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('websocket required', { status: 426 });
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    server.addEventListener('message', (event) => { void this.handleMessage(server, event.data); });
    server.addEventListener('close', () => this.remove(server));
    server.addEventListener('error', () => this.remove(server));
    return new Response(null, { status: 101, webSocket: client });
  }

  private async handleMessage(socket: WebSocket, data: string | ArrayBuffer | Blob): Promise<void> {
    if (typeof data === 'string') {
      if (data === 'hello:sender' || data === 'hello:receiver') {
        if (data === 'hello:sender' && !this.sender) this.sender = socket;
        if (data === 'hello:receiver' && !this.receiver) this.receiver = socket;
        if (this.sender && this.receiver) {
          this.sender.send('ready');
          this.receiver.send('ready');
        }
        return;
      }
    }
    const peer = socket === this.sender ? this.receiver : socket === this.receiver ? this.sender : null;
    if (!peer || peer.readyState !== WebSocket.OPEN) return;
    peer.send(data instanceof Blob ? await data.arrayBuffer() : data);
  }

  private remove(socket: WebSocket): void {
    if (this.sender === socket) this.sender = null;
    if (this.receiver === socket) this.receiver = null;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const match = /^\/ws\/([a-z]+(?:-[a-z]+){2,7})$/i.exec(url.pathname);
    if (match) {
      const stub = env.TRANSFERS.getByName(match[1].toLowerCase());
      return stub.fetch(request);
    }
    if (url.pathname === '/api/health') return Response.json({ service: 'cd-agent-sharing', transport: 'cd-relay', status: 'ok' });
    return env.ASSETS.fetch(request);
  },
};
