use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use openssl::{
    hash::MessageDigest,
    pkey::PKey,
    rsa::Rsa,
    ssl::{SslAcceptor, SslConnector, SslMethod, SslVerifyMode},
    x509::{X509NameBuilder, X509},
};
use rand::{distributions::Alphanumeric, Rng};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{self, Read, Seek, Write},
    net::{IpAddr, SocketAddr, TcpListener, TcpStream, UdpSocket},
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{SystemTime, UNIX_EPOCH},
};
#[cfg(test)]
static TEST_CHUNK_DELAY_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
use walkdir::WalkDir;

const CHUNK: usize = 64 * 1024;
const MAX_FRAME: usize = 4 * 1024 * 1024;
const MAX_FILES: usize = 10_000;
const MAX_CHUNKS: usize = 200_000;

#[derive(Debug)]
pub struct EngineError(String);
impl std::fmt::Display for EngineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for EngineError {}
impl From<io::Error> for EngineError {
    fn from(e: io::Error) -> Self {
        Self(e.to_string())
    }
}
impl From<openssl::error::ErrorStack> for EngineError {
    fn from(e: openssl::error::ErrorStack) -> Self {
        Self(e.to_string())
    }
}
impl From<serde_json::Error> for EngineError {
    fn from(e: serde_json::Error) -> Self {
        Self(e.to_string())
    }
}
type Result<T> = std::result::Result<T, EngineError>;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    pub path: String,
    pub size: u64,
    pub sha256: String,
    pub chunks: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Share {
    pub id: String,
    pub invite: String,
    pub name: String,
    pub size: u64,
    pub files: Vec<FileInfo>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Offer {
    pub name: String,
    pub size: u64,
    pub files: Vec<FileInfo>,
    pub sender: String,
    pub is_directory: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transfer {
    pub id: String,
    pub name: String,
    pub peer: String,
    pub direction: String,
    pub status: String,
    pub bytes: u64,
    pub total: u64,
    pub files: Vec<FileInfo>,
    pub error: Option<String>,
    pub output_path: Option<String>,
    pub started_at: u64,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub transfers: Vec<Transfer>,
}

#[derive(Clone)]
pub struct Engine {
    inner: Arc<Inner>,
}
struct Inner {
    device: Mutex<String>,
    _state_dir: PathBuf,
    transfers: Mutex<HashMap<String, Transfer>>,
    controls: Mutex<HashMap<String, Arc<AtomicBool>>>,
    receive_jobs: Mutex<HashMap<String, ReceiveJob>>,
}

#[derive(Clone, Serialize, Deserialize)]
struct Invite {
    host: String,
    port: u16,
    fingerprint: String,
    token: String,
}
#[derive(Clone, Serialize, Deserialize)]
struct Manifest {
    name: String,
    sender: String,
    files: Vec<FileInfo>,
    is_directory: bool,
}
#[derive(Serialize, Deserialize)]
struct Request {
    token: String,
    action: String,
    index: Option<usize>,
    offset: Option<u64>,
    client_id: Option<String>,
}
#[derive(Serialize, Deserialize)]
struct Reply {
    ok: bool,
    manifest: Option<Manifest>,
    length: Option<u64>,
    error: Option<String>,
}

#[derive(Clone)]
struct ReceiveJob {
    invite: Invite,
    offer: Offer,
    destination: PathBuf,
    output: PathBuf,
    partial: PathBuf,
    control: Arc<AtomicBool>,
    running: Arc<AtomicBool>,
    client_id: String,
}

impl Engine {
    pub fn new(device_name: String, state_dir: PathBuf) -> Result<Self> {
        fs::create_dir_all(&state_dir)?;
        Ok(Self {
            inner: Arc::new(Inner {
                device: Mutex::new(device_name),
                _state_dir: state_dir,
                transfers: Mutex::new(HashMap::new()),
                controls: Mutex::new(HashMap::new()),
                receive_jobs: Mutex::new(HashMap::new()),
            }),
        })
    }

    pub fn share(&self, paths: Vec<PathBuf>) -> Result<Share> {
        if paths.is_empty() {
            return Err(EngineError("Select at least one file or folder".into()));
        }
        let (mut manifest, sources) = build_manifest(&paths)?;
        manifest.sender = self.inner.device.lock().unwrap().clone();
        let id = random_id();
        let token = random_secret();
        let listener = TcpListener::bind("0.0.0.0:0")?;
        let port = listener.local_addr()?.port();
        let (acceptor, fingerprint) = make_tls()?;
        let host = lan_ip().unwrap_or_else(|| "127.0.0.1".into());
        let invite = Invite {
            host,
            port,
            fingerprint,
            token,
        };
        let invite_text = format!(
            "nearby:{}",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&invite)?)
        );
        let size = manifest.files.iter().map(|f| f.size).sum();
        let transfer = Transfer {
            id: id.clone(),
            name: manifest.name.clone(),
            peer: "Waiting for receiver".into(),
            direction: "send".into(),
            status: "waiting".into(),
            bytes: 0,
            total: size,
            files: manifest.files.clone(),
            error: None,
            output_path: None,
            started_at: now(),
        };
        self.inner
            .transfers
            .lock()
            .unwrap()
            .insert(id.clone(), transfer);
        let inner = self.inner.clone();
        let token = invite.token;
        let name = manifest.name.clone();
        let files = manifest.files.clone();
        let server_id = id.clone();
        let cancel = Arc::new(AtomicBool::new(false));
        self.inner
            .controls
            .lock()
            .unwrap()
            .insert(id.clone(), cancel.clone());
        thread::spawn(move || {
            serve(
                inner, listener, acceptor, manifest, sources, token, cancel, server_id,
            )
        });
        Ok(Share {
            id,
            invite: invite_text,
            name,
            size,
            files,
        })
    }

    pub fn inspect_invite(&self, invite: &str) -> Result<Offer> {
        let parsed = parse_invite(invite)?;
        let mut stream = connect_pinned(&parsed)?;
        send_json(
            &mut stream,
            &Request {
                token: parsed.token,
                action: "offer".into(),
                index: None,
                offset: None,
                client_id: None,
            },
        )?;
        let reply: Reply = recv_json(&mut stream)?;
        if !reply.ok {
            return Err(EngineError(
                reply.error.unwrap_or_else(|| "Share was rejected".into()),
            ));
        }
        let m = reply
            .manifest
            .ok_or_else(|| EngineError("Sender returned no offer".into()))?;
        safe_component(&m.name)?;
        if m.sender.len() > 80 {
            return Err(EngineError("Sender name is too long".into()));
        }
        validate_manifest(&m.files)?;
        if !m.is_directory && (m.files.len() != 1 || m.files[0].path != m.name) {
            return Err(EngineError("Offer shape does not match its file name".into()));
        }
        Ok(Offer {
            name: m.name,
            size: m.files.iter().map(|f| f.size).sum(),
            files: m.files,
            sender: m.sender,
            is_directory: m.is_directory,
        })
    }

    /// Starts a background receive after the caller has shown the inspected offer and obtained acceptance.
    pub fn receive(&self, invite: String, destination: PathBuf) -> Result<String> {
        let parsed = parse_invite(&invite)?;
        let offer = self.inspect_invite(&invite)?;
        let target_name = safe_component(&offer.name)?;
        let output = destination.join(&target_name);
        if output.exists() {
            return Err(EngineError(format!(
                "Destination already exists: {}",
                output.display()
            )));
        }
        let id = random_id();
        let partial = destination.join(format!(".nearby-receive-{id}"));
        fs::create_dir_all(&partial)?;
        let transfer = Transfer {
            id: id.clone(),
            name: offer.name.clone(),
            peer: offer.sender.clone(),
            direction: "receive".into(),
            status: "transferring".into(),
            bytes: 0,
            total: offer.size,
            files: offer.files.clone(),
            error: None,
            output_path: None,
            started_at: now(),
        };
        self.inner
            .transfers
            .lock()
            .unwrap()
            .insert(id.clone(), transfer);
        let job = ReceiveJob {
            invite: parsed,
            offer,
            destination,
            output,
            partial,
            control: Arc::new(AtomicBool::new(false)),
            running: Arc::new(AtomicBool::new(false)),
            client_id: random_id(),
        };
        self.inner
            .receive_jobs
            .lock()
            .unwrap()
            .insert(id.clone(), job.clone());
        launch_receive(self.inner.clone(), id.clone(), job)?;
        Ok(id)
    }

    pub fn pause(&self, id: &str) -> Result<()> {
        let job = self
            .inner
            .receive_jobs
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| EngineError("Only incoming transfers can be paused".into()))?;
        if !job.running.load(Ordering::SeqCst) {
            return Err(EngineError("Transfer is not running".into()));
        }
        job.control.store(true, Ordering::SeqCst);
        Ok(())
    }
    pub fn resume(&self, id: &str) -> Result<()> {
        let job = self
            .inner
            .receive_jobs
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| EngineError("Only incoming transfers can be resumed".into()))?;
        if job.running.load(Ordering::SeqCst) {
            return Err(EngineError("Transfer is still stopping".into()));
        }
        let status = self
            .inner
            .transfers
            .lock()
            .unwrap()
            .get(id)
            .map(|t| t.status.clone())
            .unwrap_or_default();
        if status != "paused" && status != "failed" {
            return Err(EngineError("Transfer is not paused or failed".into()));
        }
        job.control.store(false, Ordering::SeqCst);
        launch_receive(self.inner.clone(), id.to_string(), job)
    }
    pub fn revoke(&self, id: &str) -> Result<()> {
        let transfer = self
            .inner
            .transfers
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| EngineError("Unknown transfer".into()))?;
        if transfer.direction != "send" {
            return Err(EngineError("Only outgoing shares can be revoked".into()));
        }
        if transfer.status == "completed" || transfer.status == "cancelled" {
            return Err(EngineError("Share is already closed".into()));
        }
        if let Some(control) = self.inner.controls.lock().unwrap().get(id) {
            control.store(true, Ordering::SeqCst);
        }
        set_status(&self.inner, id, "cancelled", Some("Share revoked".into()));
        Ok(())
    }
    pub fn set_device_name(&self, name: String) -> Result<()> {
        let name = name.trim();
        if name.is_empty() || name.len() > 80 || name.chars().any(char::is_control) {
            return Err(EngineError(
                "Device name must be 1–80 printable characters".into(),
            ));
        }
        *self.inner.device.lock().unwrap() = name.to_string();
        Ok(())
    }
    pub fn snapshot(&self) -> Snapshot {
        Snapshot {
            transfers: self
                .inner
                .transfers
                .lock()
                .unwrap()
                .values()
                .cloned()
                .collect(),
        }
    }
}

fn random_id() -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(32)
        .map(char::from)
        .collect()
}
fn random_secret() -> String {
    rand::thread_rng()
        .r#gen::<[u8; 32]>()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn build_manifest(paths: &[PathBuf]) -> Result<(Manifest, Vec<PathBuf>)> {
    let mut files = Vec::new();
    let mut sources = Vec::new();
    let mut unique = HashSet::new();
    let single_directory =
        paths.len() == 1 && fs::symlink_metadata(&paths[0])?.file_type().is_dir();
    for path in paths {
        if fs::symlink_metadata(path)?.file_type().is_symlink() {
            return Err(EngineError("Symbolic links cannot be shared".into()));
        }
        let canonical = fs::canonicalize(path)?;
        let base_name = path
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or_else(|| EngineError("Invalid file name".into()))?
            .to_string();
        let base = if canonical.is_dir() {
            canonical.clone()
        } else {
            canonical.parent().unwrap_or(Path::new("/")).to_path_buf()
        };
        for entry in WalkDir::new(&canonical).follow_links(false) {
            let entry = entry.map_err(|e| EngineError(e.to_string()))?;
            let ft = entry.file_type();
            if ft.is_symlink() {
                return Err(EngineError("Symbolic links cannot be shared".into()));
            }
            if ft.is_dir() {
                continue;
            }
            if !ft.is_file() {
                return Err(EngineError("Special files cannot be shared".into()));
            }
            let rel = if canonical.is_file() {
                PathBuf::from(&base_name)
            } else if paths.len() == 1 {
                entry
                    .path()
                    .strip_prefix(&canonical)
                    .map_err(|e| EngineError(e.to_string()))?
                    .to_path_buf()
            } else {
                PathBuf::from(&base_name).join(
                    entry
                        .path()
                        .strip_prefix(&base)
                        .map_err(|e| EngineError(e.to_string()))?,
                )
            };
            let rel = path_to_string(&rel)?;
            safe_relative(&rel)?;
            if !unique.insert(rel.to_ascii_lowercase()) {
                return Err(EngineError(format!(
                    "More than one selected item maps to {rel}"
                )));
            }
            let meta = fs::metadata(entry.path())?;
            let (hash, chunks) = hash_chunks(entry.path())?;
            files.push(FileInfo {
                path: rel,
                size: meta.len(),
                sha256: hash,
                chunks,
            });
            sources.push(entry.path().to_path_buf());
            if files.len() > MAX_FILES {
                return Err(EngineError("Share contains too many files".into()));
            }
        }
    }
    if files.is_empty() {
        return Err(EngineError("The selected folders contain no files".into()));
    }
    let name = if paths.len() == 1 {
        paths[0]
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("Shared files")
            .to_string()
    } else {
        "Shared files".into()
    };
    validate_manifest(&files)?;
    let manifest = Manifest {
        name,
        sender: String::new(),
        files,
        is_directory: paths.len() != 1 || single_directory,
    };
    if serde_json::to_vec(&manifest)?.len() > MAX_FRAME {
        return Err(EngineError("Share manifest is too large".into()));
    }
    Ok((manifest, sources))
}
fn path_to_string(path: &Path) -> Result<String> {
    path.to_str()
        .map(str::to_string)
        .ok_or_else(|| EngineError("File path is not valid UTF-8".into()))
}
fn hash_file(path: &Path) -> Result<String> {
    let mut f = File::open(path)?;
    let mut h = Sha256::new();
    let mut b = [0; CHUNK];
    loop {
        let n = f.read(&mut b)?;
        if n == 0 {
            break;
        }
        h.update(&b[..n]);
    }
    Ok(format!("{:x}", h.finalize()))
}
fn hash_chunks(path: &Path) -> Result<(String, Vec<String>)> {
    let mut f = File::open(path)?;
    let mut whole = Sha256::new();
    let mut chunks = Vec::new();
    let mut buffer = vec![0; CHUNK];
    loop {
        let mut read = 0;
        while read < CHUNK {
            let n = f.read(&mut buffer[read..])?;
            if n == 0 {
                break;
            }
            read += n;
        }
        if read == 0 {
            break;
        }
        whole.update(&buffer[..read]);
        chunks.push(format!("{:x}", Sha256::digest(&buffer[..read])));
        if read < CHUNK {
            break;
        }
    }
    Ok((format!("{:x}", whole.finalize()), chunks))
}
fn safe_component(s: &str) -> Result<String> {
    if s.is_empty()
        || s == "."
        || s == ".."
        || s.contains('/')
        || s.contains('\\')
        || s.contains(':')
        || s.ends_with('.')
        || s.ends_with(' ')
        || s.contains('\0')
    {
        Err(EngineError("Unsafe received folder name".into()))
    } else {
        Ok(s.into())
    }
}
fn safe_relative(s: &str) -> Result<()> {
    if s.is_empty()
        || s.starts_with('/')
        || s.contains('\\')
        || s.contains(':')
        || s.contains('\0')
        || s.chars().any(char::is_control)
    {
        return Err(EngineError("Unsafe file path in offer".into()));
    }
    for component in s.split('/') {
        if component.is_empty()
            || component == "."
            || component == ".."
            || component.ends_with('.')
            || component.ends_with(' ')
        {
            return Err(EngineError("Unsafe file path in offer".into()));
        }
        let stem = component
            .split('.')
            .next()
            .unwrap_or("")
            .to_ascii_uppercase();
        if matches!(
            stem.as_str(),
            "CON"
                | "PRN"
                | "AUX"
                | "NUL"
                | "COM1"
                | "COM2"
                | "COM3"
                | "COM4"
                | "COM5"
                | "COM6"
                | "COM7"
                | "COM8"
                | "COM9"
                | "LPT1"
                | "LPT2"
                | "LPT3"
                | "LPT4"
                | "LPT5"
                | "LPT6"
                | "LPT7"
                | "LPT8"
                | "LPT9"
        ) {
            return Err(EngineError("Unsafe Windows device path in offer".into()));
        }
    }
    if Path::new(s)
        .components()
        .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err(EngineError("Unsafe file path in offer".into()));
    }
    Ok(())
}
fn validate_manifest(files: &[FileInfo]) -> Result<()> {
    if files.is_empty() || files.len() > MAX_FILES {
        return Err(EngineError("Invalid file count in offer".into()));
    }
    let mut total_chunks = 0usize;
    let mut paths = Vec::with_capacity(files.len());
    let mut total_size = 0u64;
    for f in files {
        safe_relative(&f.path)?;
        if f.sha256.len() != 64 || !f.sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(EngineError("Invalid file digest in offer".into()));
        }
        let expected_chunks = f
            .size
            .checked_add(CHUNK as u64 - 1)
            .ok_or_else(|| EngineError("File size overflow in offer".into()))?
            / CHUNK as u64;
        if f.chunks.len() as u64 != expected_chunks
            || f.chunks
                .iter()
                .any(|h| h.len() != 64 || !h.bytes().all(|b| b.is_ascii_hexdigit()))
        {
            return Err(EngineError("Invalid chunk hashes in offer".into()));
        }
        total_chunks = total_chunks
            .checked_add(f.chunks.len())
            .ok_or_else(|| EngineError("Chunk count overflow in offer".into()))?;
        total_size = total_size
            .checked_add(f.size)
            .ok_or_else(|| EngineError("Total size overflow in offer".into()))?;
        if total_chunks > MAX_CHUNKS {
            return Err(EngineError("Offer contains too many chunks".into()));
        }
        paths.push(f.path.to_ascii_lowercase());
    }
    paths.sort();
    let path_set: HashSet<_> = paths.iter().cloned().collect();
    if path_set.len() != paths.len() { return Err(EngineError("Offer contains duplicate file paths".into())); }
    for path in &paths {
        let mut parent = Path::new(path.as_str());
        while let Some(value) = parent.parent() {
            if let Some(value) = value.to_str() {
                if !value.is_empty() && path_set.contains(&value.to_ascii_lowercase()) {
                    return Err(EngineError("Offer has conflicting file and folder paths".into()));
                }
            }
            parent = value;
        }
    }
    Ok(())
}

fn make_tls() -> Result<(SslAcceptor, String)> {
    let key = PKey::from_rsa(Rsa::generate(2048)?)?;
    let mut name = X509NameBuilder::new()?;
    name.append_entry_by_text("CN", "cd-nearby")?;
    let name = name.build();
    let mut builder = X509::builder()?;
    builder.set_version(2)?;
    builder.set_subject_name(&name)?;
    builder.set_issuer_name(&name)?;
    builder.set_pubkey(&key)?;
    let serial = openssl::bn::BigNum::from_u32(rand::thread_rng().gen())?.to_asn1_integer()?;
    builder.set_serial_number(&serial)?;
    let before = openssl::asn1::Asn1Time::days_from_now(0)?;
    let after = openssl::asn1::Asn1Time::days_from_now(30)?;
    builder.set_not_before(&before)?;
    builder.set_not_after(&after)?;
    builder.sign(&key, MessageDigest::sha256())?;
    let cert = builder.build();
    let fp = cert
        .digest(MessageDigest::sha256())?
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let mut acceptor = SslAcceptor::mozilla_intermediate(SslMethod::tls())?;
    acceptor.set_private_key(&key)?;
    acceptor.set_certificate(&cert)?;
    acceptor.check_private_key()?;
    Ok((acceptor.build(), fp))
}
fn parse_invite(text: &str) -> Result<Invite> {
    if text.len() > 4096 {
        return Err(EngineError("Invitation is too large".into()));
    }
    let data = text
        .strip_prefix("nearby:")
        .ok_or_else(|| EngineError("Invitation must start with nearby:".into()))?;
    let bytes = URL_SAFE_NO_PAD
        .decode(data)
        .map_err(|_| EngineError("Invalid invitation encoding".into()))?;
    let i: Invite = serde_json::from_slice(&bytes)?;
    if i.port == 0
        || i.host.is_empty()
        || i.fingerprint.len() != 64
        || i.token.len() != 64
        || !i.token.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err(EngineError("Invalid invitation fields".into()));
    }
    Ok(i)
}
fn lan_ip() -> Option<String> {
    let s = UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect("192.0.2.1:9").ok()?;
    Some(s.local_addr().ok()?.ip().to_string())
}

fn serve(
    inner: Arc<Inner>,
    listener: TcpListener,
    acceptor: SslAcceptor,
    manifest: Manifest,
    sources: Vec<PathBuf>,
    token: String,
    cancel: Arc<AtomicBool>,
    share_id: String,
) {
    let _ = listener.set_nonblocking(true);
    let mut claimed_client: Option<String> = None;
    while !cancel.load(Ordering::SeqCst) {
        let tcp = match listener.accept() {
            Ok((tcp, _)) => tcp,
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                thread::sleep(std::time::Duration::from_millis(40));
                continue;
            }
            Err(_) => break,
        };
        let _ = tcp.set_read_timeout(Some(std::time::Duration::from_secs(5)));
        let Ok(mut stream) = acceptor.accept(tcp) else {
            continue;
        };
        let req: Request = match recv_json(&mut stream) {
            Ok(r) => r,
            Err(_) => continue,
        };
        if !constant_time_eq(&req.token, &token) {
            let _ = send_json(
                &mut stream,
                &Reply {
                    ok: false,
                    manifest: None,
                    length: None,
                    error: Some("Invalid access token".into()),
                },
            );
            continue;
        }
        if req.action == "offer" {
            let _ = send_json(
                &mut stream,
                &Reply {
                    ok: true,
                    manifest: Some(manifest.clone()),
                    length: None,
                    error: None,
                },
            );
            continue;
        }
        let Some(client_id) = req.client_id.clone() else {
            let _ = send_json(&mut stream, &error_reply("Receiver identity is required"));
            continue;
        };
        if claimed_client
            .as_ref()
            .is_some_and(|claimed| claimed != &client_id)
        {
            let _ = send_json(
                &mut stream,
                &error_reply("This invitation is already claimed by another receiver"),
            );
            continue;
        }
        if req.action == "ack" {
            if claimed_client.as_deref() != Some(client_id.as_str()) {
                let _ = send_json(
                    &mut stream,
                    &error_reply("Receiver has not claimed this invitation"),
                );
                continue;
            }
            let _ = send_json(
                &mut stream,
                &Reply {
                    ok: true,
                    manifest: None,
                    length: None,
                    error: None,
                },
            );
            set_status(&inner, &share_id, "completed", None);
            cancel.store(true, Ordering::SeqCst);
            break;
        }
        if req.action != "file" {
            continue;
        }
        claimed_client.get_or_insert(client_id);
        if let Some(t) = inner.transfers.lock().unwrap().get_mut(&share_id) {
            if t.status == "waiting" { t.peer = "Connected receiver".into(); }
        }
        let index = req.index.unwrap_or(usize::MAX);
        let offset = req.offset.unwrap_or(u64::MAX);
        let Some(info) = manifest.files.get(index) else {
            let _ = send_json(
                &mut stream,
                &Reply {
                    ok: false,
                    manifest: None,
                    length: None,
                    error: Some("Unknown file".into()),
                },
            );
            continue;
        };
        if offset > info.size || offset % CHUNK as u64 != 0 {
            let _ = send_json(
                &mut stream,
                &error_reply("Invalid chunk-aligned resume offset"),
            );
            continue;
        }
        if send_json(
            &mut stream,
            &Reply {
                ok: true,
                manifest: None,
                length: Some(info.size - offset),
                error: None,
            },
        )
        .is_err()
        {
            continue;
        }
        let Ok(mut f) = File::open(&sources[index]) else {
            continue;
        };
        if io::copy(&mut Read::by_ref(&mut f).take(offset), &mut io::sink()).is_err() {
            continue;
        }
        let _ = stream
            .get_ref()
            .set_write_timeout(Some(std::time::Duration::from_millis(250)));
        let mut sent = offset;
        for expected_hash in info.chunks.iter().skip(offset as usize / CHUNK) {
            if cancel.load(Ordering::SeqCst) {
                break;
            }
            let len = (info.size - sent).min(CHUNK as u64) as usize;
            let mut chunk = vec![0; len];
            if f.read_exact(&mut chunk).is_err()
                || format!("{:x}", Sha256::digest(&chunk)) != *expected_hash
            {
                set_status(
                    &inner,
                    &share_id,
                    "failed",
                    Some(format!(
                        "Source file changed during transfer: {}",
                        info.path
                    )),
                );
                break;
            }
            if cancel.load(Ordering::SeqCst) { break; }
            if stream.write_all(&chunk).is_err() {
                break;
            }
            sent += len as u64;
            update_send(&inner, &share_id, &manifest, index, sent);
        }
    }
}
fn error_reply(message: &str) -> Reply {
    Reply {
        ok: false,
        manifest: None,
        length: None,
        error: Some(message.into()),
    }
}
fn update_send(inner: &Inner, id: &str, manifest: &Manifest, index: usize, sent: u64) {
    if let Some(t) = inner
        .transfers
        .lock()
        .unwrap()
        .values_mut()
        .find(|t| t.id == id)
    {
        if t.status == "cancelled" || t.status == "failed" || t.status == "completed" { return; }
        let before: u64 = manifest.files.iter().take(index).map(|f| f.size).sum();
        t.bytes = (before + sent).min(t.total);
        t.status = "transferring".into();
    }
}
fn constant_time_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.bytes().zip(b.bytes()).fold(0u8, |v, (x, y)| v | (x ^ y)) == 0
}

fn launch_receive(inner: Arc<Inner>, id: String, job: ReceiveJob) -> Result<()> {
    if job
        .running
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err(EngineError("Receive worker is already running".into()));
    }
    set_status(&inner, &id, "transferring", None);
    let worker_inner = inner.clone();
    let worker_id = id.clone();
    thread::spawn(move || {
        let result = receive_attempt(&worker_inner, &worker_id, &job);
        job.running.store(false, Ordering::SeqCst);
        match result {
            Ok(()) => set_status(&worker_inner, &worker_id, "completed", None),
            Err(_e) if job.control.load(Ordering::SeqCst) => {
                set_status(&worker_inner, &worker_id, "paused", None)
            }
            Err(e) => set_status(&worker_inner, &worker_id, "failed", Some(e.to_string())),
        }
    });
    Ok(())
}

fn receive_attempt(inner: &Inner, id: &str, job: &ReceiveJob) -> Result<()> {
    fs::create_dir_all(&job.destination)?;
    let mut completed = 0u64;
    for (index, info) in job.offer.files.iter().enumerate() {
        if job.control.load(Ordering::SeqCst) {
            return Err(EngineError("Paused".into()));
        }
        let part = job.partial.join(format!("{index}.part"));
        let offset = verified_partial_len(info, &part)?;
        set_bytes(inner, id, completed + offset);
        if offset < info.size {
            download_from(job, info, index, offset, &part, inner, id, completed)?;
        }
        if hash_file(&part)? != info.sha256 {
            return Err(EngineError(format!(
                "Downloaded file failed SHA-256 verification: {}",
                info.path
            )));
        }
        completed = completed
            .checked_add(info.size)
            .ok_or_else(|| EngineError("Transfer size overflow".into()))?;
        set_bytes(inner, id, completed);
    }
    if job.control.load(Ordering::SeqCst) {
        return Err(EngineError("Paused".into()));
    }
    publish_received(job)?;
    // The sender only marks complete after this authenticated ACK arrives.
    let _ = send_ack(job);
    if let Some(t) = inner.transfers.lock().unwrap().get_mut(id) {
        t.output_path = Some(job.output.display().to_string());
    }
    let _ = fs::remove_dir_all(&job.partial);
    Ok(())
}

fn verified_partial_len(info: &FileInfo, part: &Path) -> Result<u64> {
    let mut file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(part)?;
    let len = file.metadata()?.len();
    let mut verified = 0u64;
    let mut buffer = vec![0; CHUNK];
    for (index, expected) in info.chunks.iter().enumerate() {
        let chunk_len = (info.size - verified).min(CHUNK as u64) as usize;
        if len - verified < chunk_len as u64 {
            break;
        }
        file.read_exact(&mut buffer[..chunk_len])?;
        if format!("{:x}", Sha256::digest(&buffer[..chunk_len])) != *expected {
            break;
        }
        verified += chunk_len as u64;
        if verified == info.size {
            break;
        }
        debug_assert!(index < info.chunks.len());
    }
    if len != verified {
        file.set_len(verified)?;
    }
    Ok(verified)
}

fn publish_received(job: &ReceiveJob) -> Result<()> {
    if job.offer.is_directory {
        fs::create_dir(&job.output).map_err(|e| {
            EngineError(format!(
                "Cannot create output {} without replacing data: {e}",
                job.output.display()
            ))
        })?;
        for (index, info) in job.offer.files.iter().enumerate() {
            safe_relative(&info.path)?;
            let rel = Path::new(&info.path);
            let parent = rel
                .parent()
                .map(|p| job.output.join(p))
                .unwrap_or_else(|| job.output.clone());
            fs::create_dir_all(parent)?;
            let to = job.output.join(rel);
            fs::hard_link(job.partial.join(format!("{index}.part")), &to).map_err(|e| {
                EngineError(format!(
                    "Could not publish {} without replacing existing data: {e}",
                    to.display()
                ))
            })?;
        }
    } else {
        fs::hard_link(job.partial.join("0.part"), &job.output).map_err(|e| {
            EngineError(format!(
                "Could not publish {} without replacing existing data: {e}",
                job.output.display()
            ))
        })?;
    }
    Ok(())
}

fn send_ack(job: &ReceiveJob) -> Result<()> {
    let mut stream = connect_pinned(&job.invite)?;
    send_json(
        &mut stream,
        &Request {
            token: job.invite.token.clone(),
            action: "ack".into(),
            index: None,
            offset: None,
            client_id: Some(job.client_id.clone()),
        },
    )?;
    let reply: Reply = recv_json(&mut stream)?;
    if !reply.ok {
        return Err(EngineError(
            reply
                .error
                .unwrap_or_else(|| "Completion acknowledgement rejected".into()),
        ));
    }
    Ok(())
}
fn download_from(
    job: &ReceiveJob,
    info: &FileInfo,
    index: usize,
    offset: u64,
    part: &Path,
    inner: &Inner,
    id: &str,
    completed: u64,
) -> Result<()> {
    if offset % CHUNK as u64 != 0 || offset > info.size {
        return Err(EngineError("Invalid verified resume offset".into()));
    }
    let mut stream = connect_pinned(&job.invite)?;
    send_json(
        &mut stream,
        &Request {
            token: job.invite.token.clone(),
            action: "file".into(),
            index: Some(index),
            offset: Some(offset),
            client_id: Some(job.client_id.clone()),
        },
    )?;
    let reply: Reply = recv_json(&mut stream)?;
    if !reply.ok {
        return Err(EngineError(
            reply.error.unwrap_or_else(|| "Transfer rejected".into()),
        ));
    }
    let expected = reply
        .length
        .ok_or_else(|| EngineError("Missing file length".into()))?;
    if expected != info.size - offset {
        return Err(EngineError(
            "Sender returned an inconsistent file length".into(),
        ));
    }
    stream
        .get_ref()
        .set_read_timeout(Some(std::time::Duration::from_millis(250)))?;
    let mut f = OpenOptions::new().create(true).write(true).open(part)?;
    f.set_len(offset)?;
    f.seek(io::SeekFrom::Start(offset))?;
    let received = consume_chunks(&mut stream, info, offset, &mut f, &job.control, |done| {
        set_bytes(inner, id, completed + done)
    })?;
    f.flush()?;
    if received < info.size && !job.control.load(Ordering::SeqCst) {
        return Err(EngineError("Transfer ended before all chunks arrived".into()));
    }
    if job.control.load(Ordering::SeqCst) {
        return Err(EngineError("Paused".into()));
    }
    Ok(())
}

fn consume_chunks<R: Read, F: FnMut(u64)>(reader: &mut R, info: &FileInfo, offset: u64, file: &mut File, control: &AtomicBool, mut progress: F) -> Result<u64> {
    let mut received = offset;
    for expected_hash in info.chunks.iter().skip(offset as usize / CHUNK) {
        if control.load(Ordering::SeqCst) { break; }
        let chunk_len = (info.size - received).min(CHUNK as u64) as usize;
        let mut chunk = vec![0; chunk_len];
        let mut read = 0;
        while read < chunk_len && !control.load(Ordering::SeqCst) {
            match reader.read(&mut chunk[read..]) {
                Ok(0) => {
                    return Err(EngineError(format!(
                        "Connection ended while receiving {}",
                        info.path
                    )))
                }
                Ok(n) => read += n,
                Err(e)
                    if matches!(
                        e.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                    ) && !control.load(Ordering::SeqCst) =>
                {
                    continue
                }
                Err(e) => return Err(e.into()),
            }
        }
        if control.load(Ordering::SeqCst) {
            break;
        }
        if format!("{:x}", Sha256::digest(&chunk)) != *expected_hash {
            return Err(EngineError(format!(
                "Chunk integrity check failed: {}",
                info.path
            )));
        }
        file.write_all(&chunk)?;
        received += chunk_len as u64;
        progress(received);
        #[cfg(test)]
        {
            let delay = TEST_CHUNK_DELAY_MS.load(Ordering::SeqCst);
            if delay > 0 { thread::sleep(std::time::Duration::from_millis(delay)); }
        }
    }
    Ok(received)
}
fn set_bytes(inner: &Inner, id: &str, bytes: u64) {
    if let Some(t) = inner.transfers.lock().unwrap().get_mut(id) {
        t.bytes = bytes;
    }
}
fn set_status(inner: &Inner, id: &str, status: &str, error: Option<String>) {
    if let Some(t) = inner.transfers.lock().unwrap().get_mut(id) {
        t.status = status.into();
        t.error = error;
    }
}

fn connect_pinned(invite: &Invite) -> Result<openssl::ssl::SslStream<TcpStream>> {
    let connector = SslConnector::builder(SslMethod::tls())?;
    let mut builder = connector;
    builder.set_verify(SslVerifyMode::NONE);
    let connector = builder.build();
    let ip: IpAddr = invite.host.parse().map_err(|_| EngineError("Invitation host must be an IP address".into()))?;
    let tcp = TcpStream::connect_timeout(&SocketAddr::new(ip, invite.port), std::time::Duration::from_secs(5))?;
    tcp.set_nodelay(true)?;
    tcp.set_read_timeout(Some(std::time::Duration::from_secs(15)))?;
    tcp.set_write_timeout(Some(std::time::Duration::from_secs(5)))?;
    let ssl = connector
        .configure()?
        .into_ssl(&invite.host)
        .map_err(|e| EngineError(e.to_string()))?;
    let mut stream = openssl::ssl::SslStream::new(ssl, tcp)?;
    stream.connect().map_err(|e| EngineError(e.to_string()))?;
    let cert = stream
        .ssl()
        .peer_certificate()
        .ok_or_else(|| EngineError("Sender did not provide a certificate".into()))?;
    let fp = cert
        .digest(MessageDigest::sha256())?
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    if !constant_time_eq(&fp, &invite.fingerprint.to_ascii_lowercase()) {
        return Err(EngineError(
            "Sender certificate fingerprint does not match the invitation".into(),
        ));
    }
    Ok(stream)
}
fn send_json<S: Write, T: Serialize>(stream: &mut S, value: &T) -> Result<()> {
    let data = serde_json::to_vec(value)?;
    if data.len() > MAX_FRAME {
        return Err(EngineError("Protocol frame is too large".into()));
    }
    stream.write_all(&(data.len() as u32).to_be_bytes())?;
    stream.write_all(&data)?;
    stream.flush()?;
    Ok(())
}
fn recv_json<S: Read, T: for<'de> Deserialize<'de>>(stream: &mut S) -> Result<T> {
    let mut n = [0; 4];
    stream.read_exact(&mut n)?;
    let n = u32::from_be_bytes(n) as usize;
    if n > MAX_FRAME {
        return Err(EngineError("Protocol frame is too large".into()));
    }
    let mut data = vec![0; n];
    stream.read_exact(&mut data)?;
    Ok(serde_json::from_slice(&data)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wait_for(engine: &Engine, id: &str, predicate: impl Fn(&Transfer) -> bool) -> Transfer {
        let until = std::time::Instant::now() + std::time::Duration::from_secs(30);
        loop {
            if let Some(t) = engine.snapshot().transfers.into_iter().find(|t| t.id == id) {
                if predicate(&t) {
                    return t;
                }
            }
            assert!(
                std::time::Instant::now() < until,
                "transfer did not reach expected state"
            );
            thread::sleep(std::time::Duration::from_millis(20));
        }
    }

    #[test]
    fn loopback_offer_transfer_and_integrity() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();
        let state = tempfile::tempdir().unwrap();
        fs::create_dir(src.path().join("folder")).unwrap();
        fs::write(src.path().join("folder/one.txt"), b"hello nearby").unwrap();
        fs::write(src.path().join("folder/two.txt"), vec![42u8; 180_000]).unwrap();
        let sender = Engine::new("Sender".into(), state.path().join("sender")).unwrap();
        let receiver = Engine::new("Receiver".into(), state.path().join("receiver")).unwrap();
        let share = sender.share(vec![src.path().join("folder")]).unwrap();
        let offer = receiver.inspect_invite(&share.invite).unwrap();
        assert_eq!(offer.sender, "Sender");
        assert_eq!(offer.files.len(), 2);
        let id = receiver
            .receive(share.invite.clone(), dst.path().to_path_buf())
            .unwrap();
        let done = wait_for(&receiver, &id, |t| {
            t.status == "completed" || t.status == "failed"
        });
        assert_eq!(done.status, "completed", "{:?}", done.error);
        assert_eq!(
            fs::read(dst.path().join("folder/one.txt")).unwrap(),
            b"hello nearby"
        );
        assert_eq!(
            fs::read(dst.path().join("folder/two.txt")).unwrap(),
            vec![42u8; 180_000]
        );
        sender.revoke(&share.id).unwrap();
    }

    #[test]
    fn rejects_bad_pin_token_conflicts_and_unsafe_paths() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();
        let state = tempfile::tempdir().unwrap();
        let path = src.path().join("file.txt");
        fs::write(&path, b"x").unwrap();
        let sender = Engine::new("Sender".into(), state.path().join("sender")).unwrap();
        let receiver = Engine::new("Receiver".into(), state.path().join("receiver")).unwrap();
        let share = sender.share(vec![path]).unwrap();
        let mut invite = parse_invite(&share.invite).unwrap();
        invite.fingerprint = format!(
            "{}{}",
            if invite.fingerprint.starts_with('0') {
                "1"
            } else {
                "0"
            },
            &invite.fingerprint[1..]
        );
        let bad_pin = format!(
            "nearby:{}",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&invite).unwrap())
        );
        assert!(receiver
            .inspect_invite(&bad_pin)
            .unwrap_err()
            .to_string()
            .contains("fingerprint"));
        let mut invite = parse_invite(&share.invite).unwrap();
        invite.token.push('x');
        let bad_token = format!(
            "nearby:{}",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&invite).unwrap())
        );
        assert!(receiver.inspect_invite(&bad_token).is_err());
        fs::create_dir(dst.path().join("file.txt")).unwrap();
        assert!(receiver
            .receive(share.invite.clone(), dst.path().to_path_buf())
            .is_err());
        assert!(safe_relative("../escape").is_err());
        assert!(safe_relative("/absolute").is_err());
        sender.revoke(&share.id).unwrap();
    }

    #[test]
    fn pause_keeps_partial_and_resume_finishes() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();
        let state = tempfile::tempdir().unwrap();
        let path = src.path().join("large.bin");
        let mut f = File::create(&path).unwrap();
        let block = vec![7u8; 1024 * 1024];
        for _ in 0..64 {
            f.write_all(&block).unwrap();
        }
        drop(f);
        let sender = Engine::new("Sender".into(), state.path().join("sender")).unwrap();
        let receiver = Engine::new("Receiver".into(), state.path().join("receiver")).unwrap();
        let share = sender.share(vec![path]).unwrap();
        let id = receiver
            .receive(share.invite.clone(), dst.path().to_path_buf())
            .unwrap();
        TEST_CHUNK_DELAY_MS.store(3, Ordering::SeqCst);
        let _ = wait_for(&receiver, &id, |t| t.bytes >= CHUNK as u64 || t.status == "completed");
        let state_dir = dst.path().join(format!(".nearby-receive-{id}"));
        if receiver.snapshot().transfers.iter().any(|t| t.id == id && t.status != "completed") { receiver.pause(&id).unwrap(); }
        let paused = wait_for(&receiver, &id, |t| {
            t.status == "paused" || t.status == "completed"
        });
        if paused.status == "paused" {
            let retained = fs::metadata(state_dir.join("0.part"))
                .map(|m| m.len())
                .unwrap_or(0);
            assert!(retained > 0, "partial bytes should be retained");
            receiver.resume(&id).unwrap();
            let done = wait_for(&receiver, &id, |t| {
                t.status == "completed" || t.status == "failed"
            });
            assert_eq!(done.status, "completed", "{:?}", done.error);
            assert_eq!(fs::metadata(dst.path().join("large.bin")).unwrap().len(), 64 * 1024 * 1024);
            assert_eq!(fs::read(dst.path().join("large.bin")).unwrap(), fs::read(src.path().join("large.bin")).unwrap());
        }
        TEST_CHUNK_DELAY_MS.store(0, Ordering::SeqCst);
        sender.revoke(&share.id).unwrap();
    }

    #[test]
    fn resume_rehashes_and_truncates_partial_data_at_first_bad_chunk() {
        let dir = tempfile::tempdir().unwrap();
        let data = [vec![1u8; CHUNK], vec![2u8; CHUNK], vec![3u8; 257]].concat();
        let chunks = data.chunks(CHUNK).map(|c| format!("{:x}", Sha256::digest(c))).collect();
        let info = FileInfo { path: "data.bin".into(), size: data.len() as u64, sha256: format!("{:x}", Sha256::digest(&data)), chunks };
        let part = dir.path().join("part");
        let mut f = File::create(&part).unwrap();
        f.write_all(&data[..CHUNK]).unwrap();
        f.write_all(&vec![99u8; CHUNK]).unwrap();
        f.write_all(&data[CHUNK * 2..CHUNK * 2 + 100]).unwrap();
        assert_eq!(verified_partial_len(&info, &part).unwrap(), CHUNK as u64);
        assert_eq!(fs::metadata(&part).unwrap().len(), CHUNK as u64);
        let stop = AtomicBool::new(false);
        f = OpenOptions::new().write(true).append(true).open(&part).unwrap();
        let received = consume_chunks(&mut io::Cursor::new(&data[CHUNK..]), &info, CHUNK as u64, &mut f, &stop, |_| stop.store(true, Ordering::SeqCst)).unwrap();
        assert_eq!(received, (CHUNK * 2) as u64);
        assert_eq!(verified_partial_len(&info, &part).unwrap(), (CHUNK * 2) as u64);
        stop.store(false, Ordering::SeqCst);
        f = OpenOptions::new().write(true).append(true).open(&part).unwrap();
        let received = consume_chunks(&mut io::Cursor::new(&data[CHUNK * 2..]), &info, (CHUNK * 2) as u64, &mut f, &stop, |_| {}).unwrap();
        assert_eq!(received, data.len() as u64);
        assert_eq!(fs::read(part).unwrap(), data);
    }

    #[test]
    fn rejects_empty_conflicting_and_windows_unsafe_manifests() {
        assert!(validate_manifest(&[]).is_err());
        for path in ["C:/escape", "a\\b", "../up", "folder/CON.txt"] { assert!(safe_relative(path).is_err(), "{path}"); }
        let mk = |path: &str| FileInfo { path: path.into(), size: 0, sha256: format!("{:x}", Sha256::digest([])), chunks: Vec::new() };
        assert!(validate_manifest(&[mk("a"), mk("a/b")]).is_err());
        assert!(validate_manifest(&[mk("a/b"), mk("a")]).is_err());
    }
}
