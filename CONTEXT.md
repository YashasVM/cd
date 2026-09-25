# CD file handoffs

CD moves files between people’s devices, locally or over the internet.

## Language

**Trusted sender**:
A person the recipient has explicitly authorized to send files that are accepted automatically. Finding a person in search does not make them trusted.

**Online handoff**:
A file transfer requiring both sending and receiving devices to be available. It does not promise later delivery through stored server copies.

**Share code**:
A short numeric code (4-5 digits) that resolves through the relay directory to one live transfer. It works in every Receive box and in `cdx receive`, expires after 15 minutes, and admits one receiver. Unlike a full link, it is not end-to-end encrypted.

**Local handoff**:
A file transfer between reachable devices on a local network that does not require internet access.

**Resume**:
Continuing an interrupted handoff from verified, retained progress instead of starting the file again.
