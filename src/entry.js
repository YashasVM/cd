const shareCode = window.location.pathname.match(/^\/([a-z]+(?:-[a-z]+){2,7})\/?$/i)?.[1];

if (shareCode && window.location.hash.length > 1) {
  import('./share.js');
} else {
  import('./main.js');
}
