import"./index-DoJwOUBG.js";import{mountRelayReceiver as e}from"./share-Cl3kMbDc.js";document.body.innerHTML=`
  <canvas id="ambient-dots" class="ambient-dots" aria-hidden="true"></canvas>
  <main class="shell share-transfer-page">
    <header class="brand-rail">
      <div class="brand-lockup"><h1>cd</h1><span class="tagline">/di·rect/</span></div>
      <p class="brand-note">private CD relay</p>
      <p class="share-description">A file is being handed to you through CD.</p>
    </header>
    <section class="workbench">
      <div id="relay-receiver"></div>
    </section>
    <p class="watermark">encrypted in your browser · <a href="/">cd.yash0.in</a></p>
  </main>`;try{let e=document.querySelector(`.share-transfer-page .watermark a`);e&&(e.textContent=window.location.host)}catch{}var t=window.location.href;history.replaceState(null,``,window.location.pathname),e(document.getElementById(`relay-receiver`),t);