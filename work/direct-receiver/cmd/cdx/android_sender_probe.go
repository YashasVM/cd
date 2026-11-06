package main

// Test-only receiver in a private copy. Stock cdx v2 receive is relay-only.
import (
 "context"
 "crypto/sha256"
 "encoding/hex"
 "encoding/json"
 "errors"
 "fmt"
 "os"
 "strconv"
 "time"
 "github.com/gorilla/websocket"
)
func init() {
 if os.Getenv("CD_ANDROID_DIRECT_PROBE")!="1" { return }
 if err:=androidSenderProbe();err!=nil{fmt.Fprintln(os.Stderr,err);os.Exit(1)}
 os.Exit(0)
}
func androidSenderProbe() error {
 ctx,cancel:=context.WithTimeout(context.Background(),10*time.Minute);defer cancel()
 invite,err:=resumeInvitation(os.Getenv("CD_TEST_LINK"));if err!=nil{return err}
 session,err:=resumeConnect(ctx,invite,"receiver",nil);if err!=nil{return err};defer session.close()
 kind,data,err:=session.next();if err!=nil{return err};if kind!=kindOffer{return errors.New("missing offer")}
 var offer resumeOffer;if err=json.Unmarshal(data,&offer);err!=nil{return err}
 size,err:=strconv.ParseUint(offer.Size,10,64);if err!=nil{return err};if offer.Direct==nil{return errors.New("no direct offer")}
 type incoming struct{data []byte;direct bool;text string;err error}
 inbox:=make(chan incoming,32)
 deliver:=func(v incoming){select{case inbox<-v:case <-ctx.Done():}}
 path,err:=newDirectPath(func(record []byte){deliver(incoming{data:record,direct:true})},func(e error){if e!=nil{deliver(incoming{err:e,direct:true})}})
 if err!=nil{return err};defer path.close();path.assembler.version=resumeVersion
 answer,err:=path.answerOffer(offer.Direct.SDP,nil);if err!=nil{return err}
 signal,_:=json.Marshal(directSignal{SDP:answer});if err=session.send(kindSignal,signal);err!=nil{return err}
 go func(){for{typ,b,e:=session.socket.ReadMessage();if e!=nil{deliver(incoming{err:e});return};if typ==websocket.TextMessage{deliver(incoming{text:string(b)})}else{deliver(incoming{data:b})}}}()
 f,err:=os.Create(os.Getenv("CD_TEST_OUT"));if err!=nil{return err};defer f.Close()
 hash:=sha256.New();empty:=hex.EncodeToString(hash.Sum(nil))
 accept,_:=json.Marshal(map[string]any{"offset":"0","prefixSha256":empty,"ackEveryBytes":1024*1024})
 if err=session.send(kindAccept,accept);err!=nil{return err}
 start:=time.Now();var offset,acked,directBytes,relayBytes uint64;switched:=false
 for{
  var frame incoming;select{case frame=<-inbox:case <-ctx.Done():return ctx.Err()}
  if frame.err!=nil{return frame.err}
  if frame.text!=""{var e resumeEvent;if json.Unmarshal([]byte(frame.text),&e)!=nil{return errors.New("bad relay event")};if e.Type=="peer-left"{return errors.New("peer left")};continue}
  kind,b,e:=session.open.open(frame.data);if e!=nil{return e}
  switch kind{
  case kindChunk:
   if len(b)==0||len(b)>chunkSize||offset+uint64(len(b))>size{return errors.New("bad chunk")}
   if frame.direct{if !switched&&offset!=acked{return errors.New("direct overtook pending relay ACK")};switched=true;directBytes+=uint64(len(b))}else{if switched{return errors.New("relay after direct switch")};relayBytes+=uint64(len(b))}
   if _,e=f.Write(b);e!=nil{return e};hash.Write(b);offset+=uint64(len(b))
   if offset-acked>=1024*1024||offset==size{if e=f.Sync();e!=nil{return e};if e=session.send(kindAck,encodeCounts(resumeCounts(offset),offset));e!=nil{return e};acked=offset}
  case kindEnd:
   digest:=hex.EncodeToString(hash.Sum(nil));if offset!=size||digest!=offer.WholeSHA256{return errors.New("whole file mismatch")}
   if e=resumeVerifyEnd(b,size,digest);e!=nil{return e};if !switched{return errors.New("no direct bytes received")}
   if e=session.send(kindComplete,b);e!=nil{return e}
   if e=session.socket.WriteJSON(map[string]any{"type":"complete","protocol":resumeProtocol,"sessionNonce":session.senderNonce,"receiverNonce":session.receiverNonce});e!=nil{return e}
   for{select{case v:=<-inbox:if v.err!=nil{return v.err};if v.text!=""{var e resumeEvent;json.Unmarshal([]byte(v.text),&e);if e.Type=="completed"{return json.NewEncoder(os.Stdout).Encode(map[string]any{"size":size,"sha256":digest,"directBytes":directBytes,"relayBytes":relayBytes,"seconds":time.Since(start).Seconds(),"bytesPerSecond":float64(size)/time.Since(start).Seconds()})}};case <-ctx.Done():return ctx.Err()}}
  default:return fmt.Errorf("unexpected kind %d",kind)
  }
 }
}
