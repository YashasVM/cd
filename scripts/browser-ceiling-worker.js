// Local transport diagnostic only. No public routes or deployment target.
export default {
  async fetch(request) {
    const path=new URL(request.url).pathname;
    if(path==='/api/health')return Response.json({ok:true});
    if(path==='/echo'&&request.method==='POST'){
      const size=Number(request.headers.get('X-Diagnostic-Bytes'));
      if(!Number.isSafeInteger(size)||size<=0||size>16*1048576)return new Response('diagnostic size limit',{status:413});
      // The local HTTP/1 streaming echo stalls before the upload completes.
      // This bounded echo diagnoses transport without duplex requirements.
      const bytes=new Uint8Array(size);let offset=0;
      for await(const chunk of request.body){
        if(offset+chunk.byteLength>size)return new Response('diagnostic overflow',{status:413});
        bytes.set(chunk,offset);offset+=chunk.byteLength;
      }
      if(offset!==size)return new Response('diagnostic truncation',{status:400});
      return new Response(bytes,{headers:{'Content-Type':'application/octet-stream'}});
    }
    if(path==='/echo'&&request.headers.get('Upgrade')?.toLowerCase()==='websocket'){
      const pair=new WebSocketPair(),server=pair[1];server.accept();server.binaryType='arraybuffer';
      server.addEventListener('message',({data})=>{
        if(typeof data==='string'||data.byteLength>1048576){server.close(4403,'invalid diagnostic frame');return;}
        if(server.bufferedAmount+data.byteLength>32*1048576){server.close(4429,'slow diagnostic client');return;}
        server.send(data);
      });
      server.addEventListener('close',()=>{try{server.close()}catch{}});
      return new Response(null,{status:101,webSocket:pair[0]});
    }
    return new Response('local transport diagnostic',{headers:{'Content-Type':'text/plain'}});
  }
};
