import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ClerkProvider, SignIn, UserButton, useAuth } from '@clerk/react';
import { appendFiles, parseReceiveTarget } from './transfer-utils.js';
import { errorText, fileSummary, openPeer, receiveFiles, sendFiles, validateFiles } from './peer-transfer.js';
import './styles.css';

const api = (import.meta.env.VITE_CONTROL_PLANE_URL || (import.meta.env.DEV ? 'http://127.0.0.1:8788' : '')).replace(/\/$/, '');
const initialTarget = parseReceiveTarget(location.href, location.origin).target;
const emailTransferId = initialTarget?.kind === 'email' ? initialTarget.transferId : '';
const guestPeerId = initialTarget?.kind === 'guest' ? initialTarget.peerId : '';

const paths = {
  search: <><circle cx="11" cy="11" r="7"/><path d="m16 16 5 5"/></>,
  plus: <path d="M12 5v14M5 12h14"/>,
  file: <><path d="M6 3h7l5 5v13H6z"/><path d="M13 3v5h5"/></>,
  close: <path d="m6 6 12 12M18 6 6 18"/>,
  arrow: <path d="M5 12h13M14 7l5 5-5 5"/>,
  check: <path d="m5 12 4 4L19 6"/>,
  copy: <><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></>
};


function Icon({ name, size = 20 }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

const clerkAppearance = {
  variables: {
    fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
    fontSize: '14px',
    borderRadius: '8px',
    colorBackground: '#191919',
    colorForeground: '#ffffff',
    colorText: '#ffffff',
    colorTextSecondary: '#7d8187',
    colorMutedForeground: '#7d8187',
    colorPrimary: '#ffffff',
    colorPrimaryForeground: '#0a0a0a',
    colorInputBackground: '#1a1c20',
    colorInputText: '#ffffff',
    colorInputBorder: '#363a3f',
    colorBorder: '#363a3f',
    colorRing: 'rgb(255 255 255 / 70%)',
    colorDanger: '#e5484d',
    colorSuccess: '#3dd68c',
    colorWarning: '#f0b429',
    colorBadgeBackground: '#1a1c20',
    colorBadgeText: '#7d8187',
  },
  elements: {
    rootBox: { width: '100%' },
    card: { backgroundColor: '#191919', border: '1px solid #212327', borderRadius: '8px', boxShadow: 'none', width: '100%' },
    navbar: { backgroundColor: 'transparent' },
    headerTitle: { fontSize: '20px', fontWeight: 400, letterSpacing: '-0.02em', color: '#ffffff' },
    headerSubtitle: { color: '#7d8187', fontSize: '14px' },
    socialButtonsBlockButton: { backgroundColor: '#1a1c20', border: '1px solid rgb(255 255 255 / 25%)', color: '#ffffff', borderRadius: '9999px', height: '42px', boxShadow: 'none' },
    socialButtonsBlockButtonText: { color: '#ffffff', fontWeight: 400 },
    dividerLine: { backgroundColor: '#212327' },
    dividerText: { color: '#5b5f66', fontSize: '11px', letterSpacing: '.08em', textTransform: 'uppercase' },
    formFieldLabel: { color: '#7d8187', fontSize: '13px' },
    formFieldInput: { backgroundColor: '#1a1c20', border: '1px solid #363a3f', borderRadius: '8px', color: '#ffffff', height: '44px', boxShadow: 'none' },
    formFieldInputShowPasswordButton: { color: '#7d8187' },
    formButtonPrimary: { backgroundColor: '#ffffff', color: '#0a0a0a', borderRadius: '9999px', fontWeight: 400, fontSize: '14px', height: '44px', boxShadow: 'none' },
    formHeaderTitle: { fontSize: '20px', fontWeight: 400, color: '#ffffff' },
    formHeaderSubtitle: { color: '#7d8187' },
    footerActionLink: { color: '#ffffff', fontWeight: 500 },
    footerActionText: { color: '#7d8187' },
    identityPreview: { backgroundColor: '#1a1c20', border: '1px solid #212327', borderRadius: '8px', boxShadow: 'none' },
    identityPreviewTextContainer: { color: '#dadbdf' },
    identityPreviewValue: { color: '#ffffff' },
    identityPreviewEditButton: { backgroundColor: '#232529', border: '1px solid #363a3f', borderRadius: '9999px', color: '#dadbdf' },
    otpCodeFieldInput: { backgroundColor: '#1a1c20', border: '1px solid #363a3f', color: '#ffffff', height: '48px' },
    alternativeMethodsBlockButton: { backgroundColor: '#1a1c20', border: '1px solid #363a3f', borderRadius: '8px', color: '#ffffff' },
    backButton: { color: '#7d8187' },
    alert: { backgroundColor: '#1a1c20', border: '1px solid #363a3f', borderRadius: '8px', color: '#dadbdf' },
    warningMessage: { backgroundColor: 'rgb(240 180 41 / 10%)', border: '1px solid rgb(240 180 41 / 30%)', color: '#f0b429' },
  },
};

const size = bytes => bytes < 1048576 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
function createIntentId() {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof cryptoApi?.getRandomValues === 'function') cryptoApi.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return [bytes.slice(0, 4), bytes.slice(4, 6), bytes.slice(6, 8), bytes.slice(8, 10), bytes.slice(10)]
    .map(group => [...group].map(byte => byte.toString(16).padStart(2, '0')).join('')).join('-');
}

async function authenticatedFetch(path, getToken, options = {}) {
  const token = await getToken();
  if (!token) throw new Error('Your sign-in expired. Sign in again.');
  const response = await fetch(`${api}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...options.headers },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.message || `${response.status} ${response.statusText}`);
  }
  return response;
}

function Header({ account, onSignIn, onGuest }) {
  return (
    <header className="header">
      <a className="logo" href="/">CD<span className="logo-packet"/></a>
      <div className="header-side">
        {account || (onSignIn ? <button className="quiet-button" onClick={onSignIn}>Sign in</button> : null)}
        {!account && onGuest ? <button className="quiet-button header-guest" onClick={onGuest}>Skip sign-in<Icon name="arrow" size={15}/></button> : null}
      </div>
    </header>
  );
}

function FileList({ files, setFiles }) {
  return (
    <div className="file-list">
      {files.map((file, index) => (
        <div className="file-row" key={`${file.name}-${file.size}-${file.lastModified}-${index}`}>
          <span className="file-index">{String(index + 1).padStart(3, '0')}</span>
          <span className="file-icon"><Icon name="file" size={17}/></span>
          <span className="file-name">{file.name}</span>
          <span className="file-size">{size(file.size)}</span>
          <button className="icon-button" aria-label={`Remove ${file.name}`} onClick={() => setFiles(current => current.filter(item => item !== file))}><Icon name="close" size={17}/></button>
        </div>
      ))}
    </div>
  );
}

function TransferReceiver({ title = 'Incoming stuff', join }) {
  const controllerRef = useRef(null);
  const urlsRef = useRef([]);
  const [otp, setOtp] = useState('');
  const [transfer, setTransfer] = useState({ phase: 'idle', progress: 0, message: '' });
  const [manifest, setManifest] = useState([]);
  const [received, setReceived] = useState(0);
  const [downloads, setDownloads] = useState([]);
  const done = transfer.phase === 'completed';
  const failed = transfer.phase === 'failed' || transfer.phase === 'cancelled';
  const active = ['connecting', 'waiting', 'transferring'].includes(transfer.phase);
  const total = manifest.reduce((sum, file) => sum + file.size, 0);
  const percent = transfer.progress || (total ? Math.min(100, Math.round(received / total * 100)) : 0);
  const downloadsByIndex = new Map(downloads.map(download => [download.index, download]));

  useEffect(() => () => {
    controllerRef.current?.destroy();
    urlsRef.current.forEach(URL.revokeObjectURL);
  }, []);

  const accept = async () => {
    controllerRef.current?.destroy();
    urlsRef.current.forEach(URL.revokeObjectURL);
    urlsRef.current = [];
    setDownloads([]);
    setManifest([]);
    setReceived(0);
    setTransfer({ phase: 'connecting', progress: 0, message: 'Connecting to sender…' });
    try {
      controllerRef.current = receiveFiles(await join(otp), {
        state: setTransfer,
        manifest: setManifest,
        progress: setReceived,
        file: download => {
          urlsRef.current.push(download.url);
          setDownloads(current => [...current.filter(item => item.index !== download.index), download]);
        },
      });
    } catch (error) {
      setTransfer({ phase: 'failed', progress: 0, message: errorText(error) });
    }
  };
  return (
    <>
      <Header onSignIn={() => location.assign('/')}/>
      <main className="receiver-page">
        <section className="receiver-card">
          <span className="card-tag">{done ? 'Transfer complete' : 'Incoming stuff'}</span>
          <h1>{title}</h1>
          <p>{done
            ? 'Everything arrived. Save it before you bounce.'
            : 'Straight from the sender. No upload queue, no mystery bucket.'}</p>
          {manifest.length ? (
            <>
              <div className="file-list">
                {manifest.map((file, index) => {
                  const download = downloadsByIndex.get(index);
                  return <div className="file-row" key={`${file.name}-${file.size}`}>
                    <span className="file-index">{String(index + 1).padStart(3, '0')}</span>
                    <span className="file-icon"><Icon name={done ? 'check' : 'file'} size={17}/></span>
                    <span className="file-name">{file.name}</span>
                    {download
                      ? <a className="download-link" href={download.url} download={file.name}>Save</a>
                      : <span className="file-size">{size(file.size)}</span>}
                  </div>;
                })}
              </div>
              {!done ? <div className="receiver-progress" aria-hidden="true"><span style={{width: `${percent}%`}}/></div> : null}
            </>
          ) : emailTransferId ? (
            <input className="text-input otp-input" inputMode="numeric" maxLength="6" value={otp} onChange={event => setOtp(event.target.value.replace(/\D/g, ''))} placeholder="Code (if asked)" aria-label="One-time code"/>
          ) : null}
          {!done ? active
            ? <button className="secondary-button receiver-cancel" onClick={() => controllerRef.current?.cancel()}>Abort mission</button>
            : <button className="primary-button" onClick={accept}>{failed ? 'Try again' : 'Grab files'}<Icon name="arrow" size={16}/></button>
          : null}
          <p className="status" role="status" data-error={failed} data-phase={transfer.phase}>
            {active && manifest.length ? `RECEIVING · ${percent}%` : transfer.message}
          </p>
          <div className="auth-facts receiver-facts" aria-label="How CD handles your files">
            <span>Peer to peer</span>
            <span>End to end encrypted</span>
            <span>Nothing parked</span>
          </div>
        </section>
      </main>
    </>
  );
}

function EmailReceive() {
  const capability = location.hash.slice(1);
  return <TransferReceiver join={async otp => {
    const response = await fetch(`${api}/v1/email-transfers/${emailTransferId}/join`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ capability, ...(otp ? { otp } : {}) }) });
    if (!response.ok) throw new Error('This invitation or code is invalid or expired.');
    return (await response.json()).peerId;
  }}/>;
}

function DirectReceive() {
  return <TransferReceiver title="Someone sent you stuff" join={async () => guestPeerId}/>;
}

function GuestApp({ onBack }) {
  const picker = useRef(null);
  const peerRef = useRef(null);
  const [mode, setMode] = useState('direct');
  const [files, setFiles] = useState([]);
  const [link, setLink] = useState('');
  const [invite, setInvite] = useState('');
  const [inviteError, setInviteError] = useState('');
  const [status, setStatus] = useState('');
  const [dragging, setDragging] = useState(false);
  const [guestToken, setGuestToken] = useState(() => {
    const token = sessionStorage.getItem('cd-guest-token');
    const expiresAt = Date.parse(sessionStorage.getItem('cd-guest-expires') || '');
    if (token && expiresAt > Date.now()) return token;
    sessionStorage.removeItem('cd-guest-token');
    sessionStorage.removeItem('cd-guest-expires');
    return '';
  });
  const [identityError, setIdentityError] = useState('');

  useEffect(() => () => peerRef.current?.destroy(), []);
  useEffect(() => {
    if (guestToken) return;
    let active = true;
    fetch(`${api}/v1/guest-identities`, { method: 'POST' })
      .then(response => { if (!response.ok) throw new Error('Guest session unavailable. Try again shortly.'); return response.json(); })
      .then(({ token, expiresAt }) => {
        if (!active) return;
        sessionStorage.setItem('cd-guest-token', token);
        sessionStorage.setItem('cd-guest-expires', expiresAt);
        setGuestToken(token);
      })
      .catch(error => { if (active) setIdentityError(errorText(error)); });
    return () => { active = false; };
  }, [guestToken]);

  const start = async () => {
    if (!files.length) return;
    try { validateFiles(files); } catch (error) { setStatus(errorText(error)); return; }
    setStatus('Making your link…');
    try {
      peerRef.current?.destroy();
      const peer = await openPeer();
      peerRef.current = peer;
      peer.on('connection', connection => connection.on('open', () => sendFiles(connection, [...files], setStatus)));
      const guestLink = `${location.origin}/?guest=${encodeURIComponent(peer.id)}`;
      setLink(guestLink);
      await navigator.clipboard?.writeText(guestLink).catch(() => {});
      setStatus('Link copied. Keep this tab alive.');
    } catch (error) { setStatus(`Couldn’t make it: ${errorText(error)}`); }
  };

  const receive = event => {
    event.preventDefault();
    const result = parseReceiveTarget(invite, location.origin);
    if (result.error) return setInviteError(result.error);
    setInviteError('');
    location.assign(result.target.href);
  };

  const pickFiles = () => picker.current?.click();
  const takeDropped = event => {
    event.preventDefault();
    setDragging(false);
    if (event.dataTransfer.files.length) setFiles(current => appendFiles(current, event.dataTransfer.files));
  };
  const totalSize = files.reduce((sum, file) => sum + file.size, 0);

  return (
    <>
      <Header onSignIn={onBack}/>
      <main className="page">
        <div className="page-head">
          <h1>Send without the paperwork.</h1>
          <p>No account. One tab. Then poof.</p>
        </div>
        <div className="mode-switch" role="tablist">
          <button role="tab" aria-selected={mode === 'direct'} className={mode === 'direct' ? 'active' : ''} onClick={() => setMode('direct')}>Direct</button>
          <button role="tab" aria-selected={mode === 'link'} className={mode === 'link' ? 'active' : ''} onClick={() => setMode('link')}>Link</button>
          <button role="tab" aria-selected={mode === 'receive'} className={mode === 'receive' ? 'active' : ''} onClick={() => setMode('receive')}>Receive</button>
        </div>
        {mode === 'direct' ? (
          guestToken
            ? <SendWorkbench getToken={async () => guestToken}/>
            : <p className="status" role="status">{identityError || 'PREPARING GUEST SESSION…'}</p>
        ) : mode === 'link' ? (
          <>
            <section
              className={`composer${dragging ? ' dragging' : ''}`}
              onDragOver={event => { event.preventDefault(); setDragging(true); }}
              onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget)) setDragging(false); }}
              onDrop={takeDropped}
            >
              <input ref={picker} hidden type="file" multiple onChange={event => { setFiles(current => appendFiles(current, event.target.files)); event.target.value = ''; }}/>
              <div className="composer-files">
                <div className="section-line">
                  <span className="step-tag">{files.length ? `${files.length} file${files.length === 1 ? '' : 's'} · ${size(totalSize)}` : 'Files'}</span>
                  <button className="text-button" onClick={pickFiles}><Icon name="plus" size={15}/>Add stuff</button>
                </div>
                {files.length ? <FileList files={files} setFiles={setFiles}/> : <button className="empty-files" onClick={pickFiles}>Drop stuff here, or browse</button>}
              </div>
              <div className="composer-foot">
                <span/>
                <button className="primary-button" disabled={!files.length} onClick={start}>Make link<Icon name="arrow" size={16}/></button>
              </div>
          {link ? <div className="share-link"><input readOnly value={link}/><button aria-label="Copy link" onClick={() => navigator.clipboard.writeText(link)}><Icon name="copy" size={18}/></button></div> : null}
        </section>
          <p className="status" role="status" data-error={/failed|expired|invalid|unavailable/i.test(status)}>{status}</p>
          </>
        ) : (
          <form className="receive-form" onSubmit={receive}>
            <label className="step-tag" htmlFor="invite">Invitation link or transfer code</label>
            <input id="invite" className="text-input" required value={invite} onChange={event => setInvite(event.target.value)} placeholder="Paste a link or code"/>
            <button className="primary-button" type="submit">Get files<Icon name="arrow" size={16}/></button>
            {inviteError ? <p className="status" role="alert" data-error="true">{inviteError}</p> : null}
          </form>
        )}
        <p className="guest-backline"><button className="guest-link" onClick={onBack}>Back to sign in</button></p>
      </main>
    </>
  );
}

// ponytail: polling is temporary; replace with presence WebSocket when that endpoint ships.
function useTransferOffers(getToken) {
  const [offers, setOffers] = useState([]);
  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const response = await authenticatedFetch('/v1/transfers/offers', getToken);
        if (active) setOffers((await response.json()).transfers || []);
      } catch { /* retry */ }
    };
    poll();
    const timer = setInterval(poll, 6000);
    return () => { active = false; clearInterval(timer); };
  }, [getToken]);
  return offers;
}

function SendApp({ getToken }) {
  const [mode, setMode] = useState('send');
  const [handledIds, setHandledIds] = useState([]);
  const offers = useTransferOffers(getToken);
  const pending = offers.filter(offer => !handledIds.includes(offer.id));

  const answer = async (offer, accepted, setStatus) => {
    setHandledIds(current => [...current, offer.id]);
    try {
      const response = await authenticatedFetch(`/v1/transfers/${offer.id}/${accepted ? 'accept' : 'decline'}`, getToken, { method: 'POST', body: '{}' });
      if (accepted) receiveFiles((await response.json()).transfer.peerId, { status: setStatus });
      else setStatus('Request declined.');
    } catch (error) { setStatus(errorText(error)); }
  };

  return (
    <>
      <Header account={<UserButton appearance={clerkAppearance}/>}/>
      <main className="page">
        <div className="page-head">
          <h1>{mode === 'send' ? 'Send stuff' : 'Catch stuff'}</h1>
          <p>{mode === 'send'
            ? 'Straight to them. Encrypted end to end.'
            : 'Incoming requests. No carrier pigeons.'}</p>
        </div>
        <div className="mode-switch" role="tablist">
          <button role="tab" aria-selected={mode === 'send'} className={mode === 'send' ? 'active' : ''} onClick={() => setMode('send')}>Send</button>
          <button role="tab" aria-selected={mode === 'receive'} className={mode === 'receive' ? 'active' : ''} onClick={() => setMode('receive')}>Receive</button>
        </div>
        {mode === 'send' ? <SendWorkbench getToken={getToken} offers={pending} onAnswer={answer}/> : <ReceivePage offers={pending} onAnswer={answer}/>}
      </main>
    </>
  );
}

function SendWorkbench({ getToken, offers, onAnswer }) {
  const picker = useRef(null);
  const peerRef = useRef(null);
  const [query, setQuery] = useState('');
  const [recipient, setRecipient] = useState(null);
  const [files, setFiles] = useState([]);
  const [requireOtp, setRequireOtp] = useState(false);
  const [status, setStatus] = useState('');
  const [shareUrl, setShareUrl] = useState('');
  const [dragging, setDragging] = useState(false);

  useEffect(() => () => peerRef.current?.destroy(), []);

  const find = async event => {
    event.preventDefault();
    const value = query.trim();
    setStatus('');
    setShareUrl('');
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return setRecipient({ type: 'email', label: value, id: value });
    const username = value.replace(/^@/, '').toLowerCase();
    setStatus('Looking for them…');
    try {
      const response = await fetch(`${api}/v1/recipients/by-username/${encodeURIComponent(username)}`);
      if (!response.ok) throw new Error('No CD user found. Use their email instead.');
      const match = await response.json();
      setRecipient({ type: 'user', label: `@${match.username}`, id: match.userId });
      setStatus('');
    } catch (error) { setRecipient(null); setStatus(errorText(error)); }
  };

  const send = async () => {
    if (!recipient || !files.length) return;
    try { validateFiles(files); } catch (error) { setStatus(errorText(error)); return; }
    const selected = [...files];
    setShareUrl('');
    setStatus('Connecting to transfer service…');
    let peer;
    try {
      peerRef.current?.destroy();
      peer = await openPeer();
      peerRef.current = peer;
      peer.on('connection', connection => connection.on('open', () => sendFiles(connection, selected, setStatus)));
    } catch (error) {
      return setStatus(`Transfer service sulked: ${errorText(error)}`);
    }
    setStatus('Sending request…');
    try {
      const body = recipient.type === 'email'
        ? { email: recipient.id, intentId: createIntentId(), peerId: peer.id, files: fileSummary(selected), requireOtp }
        : { recipientUserId: recipient.id, peerId: peer.id, files: fileSummary(selected) };
      const response = await authenticatedFetch(recipient.type === 'email' ? '/v1/recipients/email-capability' : '/v1/transfers', getToken, { method: 'POST', body: JSON.stringify(body) });
      const result = await response.json();
      if (result.receiveUrl) {
        setShareUrl(result.receiveUrl);
        await navigator.clipboard?.writeText(result.receiveUrl).catch(() => {});
        setStatus('Invite copied. Send it and keep this tab alive.');
      } else setStatus(recipient.type === 'email' ? 'Email sent. Keep this tab alive.' : 'Request sent. Keep this tab alive.');
    } catch (error) {
      peer.destroy();
      setStatus(`Request flopped: ${errorText(error)}`);
    }
  };

  const pickFiles = () => picker.current?.click();
  const takeDropped = event => {
    event.preventDefault();
    setDragging(false);
    if (recipient && event.dataTransfer.files.length) setFiles(current => appendFiles(current, event.dataTransfer.files));
  };
  const totalSize = files.reduce((sum, file) => sum + file.size, 0);

  return (
    <>
      <section
          className={`composer${dragging ? ' dragging' : ''}`}
          onDragOver={event => { event.preventDefault(); if (recipient) setDragging(true); }}
          onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget)) setDragging(false); }}
          onDrop={takeDropped}
        >
          <input ref={picker} hidden type="file" multiple onChange={event => { setFiles(current => appendFiles(current, event.target.files)); event.target.value = ''; }}/>
          <div className="composer-to">
            <span className="composer-label">To</span>
            {recipient ? (
              <span className="composer-target">
                <span className="avatar">{recipient.label[recipient.label.startsWith('@') ? 1 : 0].toUpperCase()}</span>
                <strong>{recipient.label}</strong>
                <small>{recipient.type === 'email' ? 'EMAIL' : 'CD USER'}</small>
                <button className="icon-button" aria-label="Change recipient" onClick={() => setRecipient(null)}><Icon name="close" size={16}/></button>
              </span>
            ) : (
              <form className="composer-find" onSubmit={find}>
                <input className="bare-input" required value={query} onChange={event => setQuery(event.target.value)} placeholder="username or email" aria-label="Recipient username or email" autoFocus/>
                <button className="inline-find" type="submit">Find</button>
              </form>
            )}
          </div>
          <div className="composer-files">
            <div className="section-line">
              <span className="step-tag">{files.length ? `${files.length} file${files.length === 1 ? '' : 's'} · ${size(totalSize)}` : 'Files'}</span>
              {recipient ? <button className="text-button" onClick={pickFiles}><Icon name="plus" size={15}/>Add stuff</button> : null}
            </div>
            {files.length ? (
              <FileList files={files} setFiles={setFiles}/>
            ) : (
              <button className="empty-files" disabled={!recipient} onClick={pickFiles}>
                {recipient ? 'Drop stuff here, or browse' : 'Find someone first'}
              </button>
            )}
          </div>
              <div className="composer-foot">
                {recipient?.type === 'email' ? (
                  <label className="otp-check"><input type="checkbox" checked={requireOtp} onChange={event => setRequireOtp(event.target.checked)}/>Require a one-time password</label>
                ) : <span/>}
                <button className="primary-button" disabled={!files.length} onClick={send}>Send it<Icon name="arrow" size={16}/></button>
              </div>
          {shareUrl ? <div className="share-link"><input readOnly value={shareUrl}/><button aria-label="Copy invitation" onClick={() => navigator.clipboard.writeText(shareUrl)}><Icon name="copy" size={18}/></button></div> : null}
        </section>
        <p className="status" role="status" data-error={/failed|expired|invalid|unavailable|No CD user/i.test(status)}>{status}</p>
      {offers[0] ? (
        <div className="dialog-backdrop">
          <section className="incoming-dialog" role="dialog" aria-modal="true">
            <button className="dialog-close" aria-label="Close" onClick={() => onAnswer(offers[0], false, setStatus)}><Icon name="close" size={18}/></button>
            <h2>Incoming stuff</h2>
            <p>Someone wants to send you {offers[0].manifest.length} file{offers[0].manifest.length === 1 ? '' : 's'}.</p>
            <div className="incoming-files">
              {offers[0].manifest.slice(0, 4).map(file => <div key={file.name}><Icon name="file" size={17}/><span>{file.name}</span><small>{size(file.size)}</small></div>)}
            </div>
            <div className="dialog-actions">
              <button className="secondary-button" onClick={() => onAnswer(offers[0], false, setStatus)}>Decline</button>
              <button className="primary-button" onClick={() => onAnswer(offers[0], true, setStatus)}>Accept</button>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}

function ReceiveOfferRow({ offer, onAnswer }) {
  const [status, setStatus] = useState('');
  const settled = /successfully|failed|declined/i.test(status);
  const total = offer.manifest.reduce((sum, file) => sum + file.size, 0);
  return (
    <div className="receive-row">
      <span className="file-icon"><Icon name="file" size={17}/></span>
      <span className="receive-meta">
        <strong>Incoming transfer</strong>
        <small>{offer.manifest.length} FILE{offer.manifest.length === 1 ? '' : 'S'} · {size(total)}</small>
      </span>
      {settled ? (
        <p className="status" role="status">{status}</p>
      ) : (
        <span className="row-actions">
          <button className="secondary-button" onClick={() => onAnswer(offer, false, setStatus)}>Decline</button>
          <button className="primary-button" onClick={() => onAnswer(offer, true, setStatus)}>Accept</button>
        </span>
      )}
    </div>
  );
}

function ReceivePage({ offers, onAnswer }) {
  const [invite, setInvite] = useState('');
  const [inviteError, setInviteError] = useState('');
  const open = event => {
    event.preventDefault();
    const result = parseReceiveTarget(invite, location.origin);
    if (result.error) return setInviteError(result.error);
    setInviteError('');
    location.assign(result.target.href);
  };
  return (
    <>
      <section className="composer">
        <div className="composer-files">
          <div className="section-line">
            <span className="step-tag">{offers.length ? `${offers.length} incoming request${offers.length === 1 ? '' : 's'}` : 'Requests'}</span>
          </div>
          {offers.length ? (
            <div className="file-list">
              {offers.map(offer => <ReceiveOfferRow key={offer.id} offer={offer} onAnswer={onAnswer}/>)}
            </div>
          ) : (
            <p className="empty-files">No takers yet. Requests will show up here.</p>
          )}
        </div>
      </section>
      <form className="receive-form" onSubmit={open}>
        <label className="step-tag" htmlFor="invite">Invitation link or transfer code</label>
        <input id="invite" className="text-input" required value={invite} onChange={event => setInvite(event.target.value)} placeholder="Paste a link or code"/>
        <button className="primary-button" type="submit">Get files<Icon name="arrow" size={16}/></button>
        {inviteError ? <p className="status" role="alert" data-error="true">{inviteError}</p> : null}
      </form>
    </>
  );
}

function AuthHero({ children }) {
  return (
    <main className="auth-page">
      <section className="auth-hero">
        <p className="auth-kicker">CD · Direct file transfer</p>
        <h1>Send it. Directly.</h1>
        <p>Files go straight from you to them. No upload queue. No mystery bucket.</p>
        {children}
        <div className="auth-facts" aria-label="How CD handles your files">
          <span>Peer to peer</span>
          <span>End to end encrypted</span>
          <span>Nothing parked</span>
        </div>
      </section>
    </main>
  );
}

function AuthScreen({ clerk, onGuest, loading = false }) {
  return (
    <>
      <Header onGuest={onGuest}/>
      <main className="auth-page">
        <div className="auth-split">
          <section className="auth-brand">
            <p className="auth-kicker">CD · Direct file transfer</p>
            <h1>Send it<br/>directly.</h1>
            <p className="auth-sub">Files go straight from you to them. No upload queue. No mystery bucket.</p>
            <div className="auth-facts" aria-label="How CD handles your files">
              <span>Peer to peer</span>
              <span>End to end encrypted</span>
              <span>Nothing parked</span>
            </div>
          </section>
          <section className="auth-panel">
            {clerk && !loading ? (
              <SignIn/>
            ) : (
              <p className="auth-loading">{loading ? 'SIGN-IN OPTIONS LOADING' : 'SIGN-IN IS UNAVAILABLE RIGHT NOW'}</p>
            )}
            <div className="guest-cta">
              <button className="secondary-button" onClick={onGuest}><Icon name="arrow" size={16}/>Continue as guest</button>
              <p className="guest-note">NO ACCOUNT · LIVE LINKS NEED THIS TAB OPEN</p>
            </div>
          </section>
        </div>
      </main>
    </>
  );
}

function ClerkGate() {
  const { isLoaded, isSignedIn, getToken } = useAuth();
  const [guest, setGuest] = useState(false);
  if (guest) return <GuestApp onBack={() => setGuest(false)}/>;
  if (!isLoaded) return <AuthScreen onGuest={() => setGuest(true)} loading/>;
  return isSignedIn ? <SendApp getToken={getToken}/> : <AuthScreen clerk onGuest={() => setGuest(true)}/>;
}

const key = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
function GuestFallbackGate() {
  const [guest, setGuest] = useState(false);
  return guest ? <GuestApp onBack={() => setGuest(false)}/> : <AuthScreen onGuest={() => setGuest(true)}/>;
}

const app = emailTransferId ? <EmailReceive/> : guestPeerId ? <DirectReceive/>
  : key ? <ClerkProvider publishableKey={key} afterSignOutUrl="/" appearance={clerkAppearance}><ClerkGate/></ClerkProvider>
  : <GuestFallbackGate/>;

createRoot(document.getElementById('root')).render(app);
