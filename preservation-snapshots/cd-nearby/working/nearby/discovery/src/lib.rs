use rand::RngCore;
use serde::{Deserialize, Serialize};
use socket2::{Domain, Protocol, SockAddr, Socket, Type};
use std::io;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const GROUP: Ipv4Addr = Ipv4Addr::new(239, 255, 77, 77);
const PORT: u16 = 47_777;
const MAX_PACKET: usize = 1024;
const MAX_PEERS: usize = 256;
const PEER_TTL_MS: u64 = 10_000;
const HEARTBEAT: Duration = Duration::from_secs(2);
const PROTOCOL_VERSION: u8 = 1;

/// An unauthenticated LAN presence record. Discovery is not proof of identity.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Peer {
    pub id: String,
    pub name: String,
    pub address: String,
    pub last_seen: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Announcement {
    protocol: u8,
    id: String,
    name: String,
}

struct State {
    name: Arc<Mutex<String>>,
    peers: Arc<Mutex<Vec<Peer>>>,
    stopping: Arc<AtomicBool>,
    last_error: Arc<Mutex<Option<String>>>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

/// A handle to the LAN discovery worker. Clones share its lifetime; the worker
/// stops and is joined when the final handle is dropped.
#[derive(Clone)]
pub struct Discovery(Arc<State>);

impl Discovery {
    pub fn start(name: String) -> io::Result<Self> {
        let name = sanitize_name(&name)?;
        let socket = open_socket()?;
        let id = random_id();
        let state = Arc::new(State {
            name: Arc::new(Mutex::new(name)),
            peers: Arc::new(Mutex::new(Vec::new())),
            stopping: Arc::new(AtomicBool::new(false)),
            last_error: Arc::new(Mutex::new(None)),
            worker: Mutex::new(None),
        });
        let worker_name = Arc::clone(&state.name);
        let worker_peers = Arc::clone(&state.peers);
        let worker_stopping = Arc::clone(&state.stopping);
        let worker_error = Arc::clone(&state.last_error);
        let worker = thread::Builder::new()
            .name("cd-nearby-discovery".into())
            .spawn(move || {
                run(
                    socket,
                    id,
                    worker_name,
                    worker_peers,
                    worker_stopping,
                    worker_error,
                )
            })?;
        *state.worker.lock().unwrap_or_else(|e| e.into_inner()) = Some(worker);
        Ok(Self(state))
    }

    /// Returns peers whose most recent announcement arrived within 10 seconds.
    pub fn peers(&self) -> Vec<Peer> {
        let now = now_ms();
        let mut peers = self.0.peers.lock().unwrap_or_else(|e| e.into_inner());
        peers.retain(|peer| now.saturating_sub(peer.last_seen) <= PEER_TTL_MS);
        peers.clone()
    }

    /// Updates the name used by subsequent announcements.
    pub fn set_name(&self, name: String) -> io::Result<()> {
        let name = sanitize_name(&name)?;
        *self.0.name.lock().unwrap_or_else(|e| e.into_inner()) = name;
        Ok(())
    }

    /// Returns the latest non-transient socket error observed by the worker.
    pub fn last_error(&self) -> Option<String> {
        self.0
            .last_error
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
}

impl Drop for State {
    fn drop(&mut self) {
        self.stopping.store(true, Ordering::Release);
        if let Some(worker) = self
            .worker
            .get_mut()
            .unwrap_or_else(|e| e.into_inner())
            .take()
        {
            let _ = worker.join();
        }
    }
}

fn open_socket() -> io::Result<UdpSocket> {
    let socket = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
    socket.set_reuse_address(true)?;
    #[cfg(unix)]
    socket.set_reuse_port(true)?;
    socket.set_nonblocking(false)?;
    socket.set_read_timeout(Some(Duration::from_millis(250)))?;
    socket.bind(&SockAddr::from(SocketAddrV4::new(
        Ipv4Addr::UNSPECIFIED,
        PORT,
    )))?;
    socket.join_multicast_v4(&GROUP, &Ipv4Addr::UNSPECIFIED)?;
    socket.set_multicast_ttl_v4(1)?;
    socket.set_multicast_loop_v4(true)?;
    Ok(socket.into())
}

fn run(
    socket: UdpSocket,
    id: String,
    name: Arc<Mutex<String>>,
    peers: Arc<Mutex<Vec<Peer>>>,
    stopping: Arc<AtomicBool>,
    last_error: Arc<Mutex<Option<String>>>,
) {
    let destination = SocketAddr::V4(SocketAddrV4::new(GROUP, PORT));
    let mut last_sent = None;
    // One extra byte lets us identify and reject a truncated oversized datagram.
    let mut packet = [0_u8; MAX_PACKET + 1];
    while !stopping.load(Ordering::Acquire) {
        let now = std::time::Instant::now();
        if last_sent.map_or(true, |last: std::time::Instant| {
            now.duration_since(last) >= HEARTBEAT
        }) {
            let announcement = Announcement {
                protocol: PROTOCOL_VERSION,
                id: id.clone(),
                name: name.lock().unwrap_or_else(|e| e.into_inner()).clone(),
            };
            if let Ok(bytes) = serde_json::to_vec(&announcement) {
                if bytes.len() <= MAX_PACKET {
                    match socket.send_to(&bytes, destination) {
                        Ok(_) => {}
                        Err(error) => set_error(&last_error, error),
                    }
                }
            }
            last_sent = Some(now);
        }

        match socket.recv_from(&mut packet) {
            Ok((length, address)) => {
                if length > MAX_PACKET {
                    continue;
                }
                if address.ip().is_ipv4() {
                    ingest(&id, &peers, &packet[..length], address);
                }
            }
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock
                        | io::ErrorKind::TimedOut
                        | io::ErrorKind::Interrupted
                ) => {}
            Err(error) => {
                set_error(&last_error, error);
                thread::sleep(Duration::from_millis(100));
            }
        }
    }
}

fn ingest(id: &str, peer_store: &Mutex<Vec<Peer>>, bytes: &[u8], source: SocketAddr) {
    if bytes.is_empty() || bytes.len() > MAX_PACKET {
        return;
    }
    let Ok(announcement) = serde_json::from_slice::<Announcement>(bytes) else {
        return;
    };
    if announcement.protocol != PROTOCOL_VERSION
        || announcement.id == id
        || !valid_id(&announcement.id)
    {
        return;
    }
    let Ok(name) = sanitize_name(&announcement.name) else {
        return;
    };
    // Require the on-wire name to already be sanitized to reject malformed peers.
    if name != announcement.name {
        return;
    }
    let peer = Peer {
        id: announcement.id,
        name,
        address: source.to_string(),
        last_seen: now_ms(),
    };
    let mut peers = peer_store.lock().unwrap_or_else(|e| e.into_inner());
    peers.retain(|p| now_ms().saturating_sub(p.last_seen) <= PEER_TTL_MS);
    if let Some(existing) = peers.iter_mut().find(|p| p.id == peer.id) {
        *existing = peer;
    } else if peers.len() < MAX_PEERS {
        peers.push(peer);
    }
}

fn set_error(last_error: &Mutex<Option<String>>, error: io::Error) {
    *last_error.lock().unwrap_or_else(|e| e.into_inner()) = Some(error.to_string());
}

fn sanitize_name(name: &str) -> io::Result<String> {
    let sanitized: String = name.chars().filter(|c| !c.is_control()).take(64).collect();
    let sanitized = sanitized.trim().to_owned();
    if sanitized.is_empty() || sanitized.len() > 256 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "display name must contain 1–64 visible characters",
        ));
    }
    Ok(sanitized)
}

fn valid_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit())
}

fn random_id() -> String {
    let mut bytes = [0_u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> State {
        State {
            name: Arc::new(Mutex::new("test".into())),
            peers: Arc::new(Mutex::new(Vec::new())),
            stopping: Arc::new(AtomicBool::new(false)),
            last_error: Arc::new(Mutex::new(None)),
            worker: Mutex::new(None),
        }
    }

    #[test]
    fn sanitizes_display_names_and_rejects_empty_names() {
        assert_eq!(sanitize_name("  Ada\nLovelace\t").unwrap(), "AdaLovelace");
        assert_eq!(
            sanitize_name(" \n").unwrap_err().kind(),
            io::ErrorKind::InvalidInput
        );
        assert_eq!(sanitize_name(&"x".repeat(100)).unwrap(), "x".repeat(64));
    }

    #[test]
    fn accepts_only_valid_protocol_records_and_refreshes_expiry() {
        let state = state();
        let local_id = "00000000000000000000000000000000";
        let source = "192.168.1.7:47777".parse().unwrap();
        let valid = br#"{"protocol":1,"id":"11111111111111111111111111111111","name":"Ada"}"#;
        ingest(local_id, &state.peers, valid, source);
        let peers = state.peers.lock().unwrap();
        assert_eq!(peers.len(), 1);
        assert_eq!(peers[0].name, "Ada");
        assert_eq!(peers[0].address, "192.168.1.7:47777");
        drop(peers);
        ingest(local_id, &state.peers, valid, source);
        assert_eq!(state.peers.lock().unwrap().len(), 1);
        ingest(
            local_id,
            &state.peers,
            br#"{"protocol":2,"id":"22222222222222222222222222222222","name":"Bob"}"#,
            source,
        );
        ingest(
            local_id,
            &state.peers,
            br#"{"protocol":1,"id":"00000000000000000000000000000000","name":"self"}"#,
            source,
        );
        ingest(
            local_id,
            &state.peers,
            br#"{"protocol":1,"id":"33333333333333333333333333333333","name":"bad\nname"}"#,
            source,
        );
        ingest(local_id, &state.peers, &vec![b'x'; MAX_PACKET + 1], source);
        assert_eq!(state.peers.lock().unwrap().len(), 1);
    }

    #[test]
    fn peer_query_prunes_expired_records() {
        let state = state();
        state.peers.lock().unwrap().push(Peer {
            id: "1".into(),
            name: "old".into(),
            address: "127.0.0.1:47777".into(),
            last_seen: now_ms().saturating_sub(PEER_TTL_MS + 1),
        });
        let discovery = Discovery(Arc::new(state));
        assert!(discovery.peers().is_empty());
    }

    #[test]
    fn peer_store_is_bounded_under_unique_peer_flood() {
        let state = state();
        let source = "192.168.1.7:47777".parse().unwrap();
        let local_id = "00000000000000000000000000000000";
        for value in 1..=(MAX_PEERS + 20) {
            let id = format!("{value:032x}");
            let record = Announcement {
                protocol: PROTOCOL_VERSION,
                id,
                name: "Peer".into(),
            };
            ingest(
                local_id,
                &state.peers,
                &serde_json::to_vec(&record).unwrap(),
                source,
            );
        }
        assert_eq!(state.peers.lock().unwrap().len(), MAX_PEERS);
    }
}
