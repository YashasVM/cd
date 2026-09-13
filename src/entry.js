const agentShare = /^\/s\/[A-Za-z0-9_-]{22}\/?$/.test(window.location.pathname);

if (agentShare) {
  import('./share.js');
} else {
  import('./main.js');
}
